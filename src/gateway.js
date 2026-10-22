import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import packageInfo from "../package.json" with { type: "json" };
import { executeOperation } from "./commands/call.js";
import { matchFilter } from "./glob.js";
import { enforcePolicy } from "./policy.js";
import { allEntries, getRegistry } from "./registry.js";
import { resolveSpec } from "./resolve.js";
import { operationSchema, operationQuery } from "./gateway-schema.js";

const object = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const text = { type: "string", minLength: 1, maxLength: 256 };
const pagination = {
  offset: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
};
const metaTools = [
  {
    name: "list_specs",
    description: "List available specs, without loading their tool schemas.",
    inputSchema: object(pagination),
  },
  {
    name: "list_tools",
    description: "List compact tool summaries for a spec. Fetch a schema with get_tool.",
    inputSchema: object({ spec: text, ...pagination }, ["spec"]),
  },
  {
    name: "search_tools",
    description: "Search permitted tool names and descriptions, optionally within a spec.",
    inputSchema: object({ query: text, spec: text, ...pagination }, ["query"]),
  },
  {
    name: "get_tool",
    description: "Get one qualified tool ID and its complete input schema.",
    inputSchema: object({ tool: text }, ["tool"]),
  },
  {
    name: "call_tool",
    description: "Call a qualified tool using arguments matching its get_tool schema.",
    inputSchema: object({ tool: text, arguments: { type: "object" } }, ["tool", "arguments"]),
  },
];

function page(items, args) {
  const offset = args.offset || 0;
  const limit = args.limit || 20;
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function parseSelection(params = new URLSearchParams()) {
  for (const key of params.keys()) {
    if (!["mode", "specs", "tools"].includes(key) || params.getAll(key).length !== 1)
      throw new Error("Unknown or repeated gateway parameter");
  }
  const mode = params.get("mode") ?? "meta";
  if (!["meta", "tools"].includes(mode)) throw new Error("mode must be meta or tools");
  const selection = { mode };
  for (const key of ["specs", "tools"]) {
    if (!params.has(key)) continue;
    const values = params
      .get(key)
      .split(",")
      .map((item) => item.trim());
    if (
      values.length > 100 ||
      values.some((item) => !item || item.length > 256 || /[\x00-\x20]/.test(item))
    )
      throw new Error(`Invalid ${key} filter`);
    selection[key] = [...new Set(values)];
  }
  return selection;
}

export function createGateway(selection, config = {}, dependencies = {}) {
  const registry = dependencies.registry || getRegistry;
  const resolve = dependencies.resolve || resolveSpec;
  const execute = dependencies.execute || executeOperation;

  function entries() {
    return allEntries(registry()).filter(
      (entry) =>
        entry.enabled &&
        (!config.specs || config.specs.includes(entry.name)) &&
        (!config.tools || config.tools.some((tool) => tool.startsWith(`${entry.name}.`))) &&
        (!selection.specs || selection.specs.includes(entry.name)) &&
        (!selection.tools || selection.tools.some((tool) => tool.startsWith(`${entry.name}.`)))
    );
  }

  async function catalog(name) {
    const permitted = entries();
    if (name && !permitted.some((entry) => entry.name === name))
      throw new Error("Unavailable spec");
    const tools = [];
    for (const entry of permitted.filter((item) => !name || item.name === name)) {
      const { spec } = await resolve({ spec: entry.name });
      const restrictions = entry._section === "mcp" ? entry : entry.config || {};
      for (const operation of spec.tools || spec.operations || []) {
        if (operation.kind === "subscription") continue;
        const id = operation.id || operation.name;
        const qualified = `${entry.name}.${id}`;
        if (
          restrictions.allowedTools?.length &&
          !restrictions.allowedTools.some((pattern) => matchFilter(pattern, id))
        )
          continue;
        if (restrictions.disabledTools?.some((pattern) => matchFilter(pattern, id))) continue;
        if (config.tools && !config.tools.includes(qualified)) continue;
        if (config.disabledTools?.includes(qualified)) continue;
        if (selection.tools && !selection.tools.includes(qualified)) continue;
        tools.push({
          id: qualified,
          specName: entry.name,
          operation,
          spec,
          entry,
          description: operation.description || operation.summary || "",
        });
      }
    }
    if (new Set(tools.map((tool) => tool.id)).size !== tools.length)
      throw new Error("Ambiguous operation IDs");
    return tools;
  }

  async function find(id) {
    const candidates = entries().filter((entry) => id.startsWith(`${entry.name}.`));
    const matches = [];
    for (const entry of candidates) {
      const found = (await catalog(entry.name)).find((tool) => tool.id === id);
      if (found) matches.push(found);
    }
    if (matches.length === 1) return matches[0];
    throw new Error("Unavailable tool");
  }

  function describe(tool) {
    return {
      id: tool.id,
      spec: tool.specName,
      description: tool.description,
      inputSchema: operationSchema(tool.spec, tool.operation),
    };
  }

  async function call(id, args) {
    const tool = await find(id);
    const schema = operationSchema(tool.spec, tool.operation);
    const validation = new AjvJsonSchemaValidator().getValidator(schema)(args);
    if (!validation.valid)
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid arguments: ${validation.errorMessage}` }],
      };
    const target = tool.operation.id || tool.operation.name;
    enforcePolicy({
      spec: tool.specName,
      tool: target,
      args: { ...args, ...args.path, ...args.query, ...args.body },
    });
    const flags = { spec: tool.specName, exactTarget: true };
    if (tool.spec.type === "openapi") {
      if (Object.values(args.path || {}).some((value) => value === "." || value === ".."))
        throw new Error("Invalid path value");
      flags.var = Object.entries(args.path || {}).map(([key, value]) => `${key}=${value}`);
      flags.query = Object.entries(args.query || {}).map(
        ([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : value}`
      );
      flags.queryEntries = operationQuery(tool.spec, tool.operation, args.query);
      if (Object.hasOwn(args, "body")) flags.data = JSON.stringify(args.body);
    } else if (tool.spec.type === "graphql") {
      flags.data = JSON.stringify({ variables: args });
      flags.generatedQuery = true;
    } else flags.data = JSON.stringify(args);
    const payload = await execute(tool.spec, tool.entry, target, flags);
    if (tool.spec.type === "mcp")
      return payload.result || { content: payload.content, isError: payload.isError };
    const value =
      tool.spec.type === "openapi"
        ? { status: payload.status, body: payload.body }
        : { status: payload.status, data: payload.data, errors: payload.errors };
    return { ...result(value), isError: payload.status >= 400 || Boolean(payload.errors) };
  }

  return { entries, catalog, find, describe, call };
}

export function directToolName(id) {
  const prefix = id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 90);
  return `${prefix}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

export function createGatewayServer(selection, config = {}, dependencies = {}) {
  const gateway = createGateway(selection, config, dependencies);
  // Upstream JSON Schemas are kept intact through the SDK's advanced Server API.
  const server = new Server(
    { name: "spec-cli", version: packageInfo.version },
    {
      capabilities: { tools: {} },
      instructions:
        selection.mode === "meta"
          ? "Discover tools with list_specs, list_tools/search_tools, then get_tool and call_tool. URL filters restrict available specs and tools."
          : "Call the exposed tools directly using their input schemas. URL filters restrict available specs and tools.",
    }
  );
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    try {
      if (selection.mode === "meta") return { tools: metaTools };
      const tools = await gateway.catalog();
      const cursor = request.params?.cursor || "0";
      if (!/^\d+$/.test(cursor)) throw new Error("Invalid cursor");
      const offset = Number(cursor);
      const items = tools.slice(offset, offset + 100).map((tool) => ({
        name: directToolName(tool.id),
        description: `${tool.id}: ${tool.description}`,
        inputSchema: gateway.describe(tool).inputSchema,
      }));
      return {
        tools: items,
        ...(offset + 100 < tools.length ? { nextCursor: String(offset + 100) } : {}),
      };
    } catch {
      throw new McpError(ErrorCode.InternalError, "Unable to list available tools");
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args = {} } = request.params;
      if (selection.mode === "tools") {
        const tool = (await gateway.catalog()).find((item) => directToolName(item.id) === name);
        if (!tool) throw new Error("Unavailable tool");
        return await gateway.call(tool.id, args);
      }
      const meta = metaTools.find((tool) => tool.name === name);
      if (!meta) throw new Error("Unavailable tool");
      const validation = new AjvJsonSchemaValidator().getValidator(meta.inputSchema)(args);
      if (!validation.valid)
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${validation.errorMessage}` }],
        };
      if (name === "list_specs")
        return result(
          page(
            gateway.entries().map((entry) => ({
              name: entry.name,
              type: entry._section,
              description: (entry.description || "").slice(0, 240),
            })),
            args
          )
        );
      if (name === "get_tool") return result(gateway.describe(await gateway.find(args.tool)));
      if (name === "call_tool") return await gateway.call(args.tool, args.arguments);
      let tools = await gateway.catalog(args.spec);
      if (name === "search_tools")
        tools = tools.filter((tool) =>
          `${tool.id} ${tool.description}`.toLowerCase().includes(args.query.toLowerCase())
        );
      return result(
        page(
          tools.map((tool) => ({ id: tool.id, description: tool.description.slice(0, 240) })),
          args
        )
      );
    } catch {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Tool unavailable, blocked by policy, or upstream request failed.",
          },
        ],
      };
    }
  });
  return server;
}

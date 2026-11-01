import { createHash } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createToolCatalog,
  errorResult,
  textResult,
  validateArguments,
  type ToolCatalog,
  type ToolCatalogOptions,
  type ToolScope,
} from "./catalog.ts";
import { allEntries, getRegistry } from "./registry.ts";
import type { JsonObject, JsonSchema, Page, PageOptions } from "./types.ts";
import { VERSION } from "./version.ts";

export type GatewayMode = "meta" | "tools";

export interface GatewaySelection {
  mode: GatewayMode;
  specs?: string[];
  tools?: string[];
}

export type GatewayDependencies = Partial<ToolCatalogOptions>;

function object(
  properties: Record<string, JsonSchema>,
  required: string[] = []
): Tool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

const text = { type: "string", minLength: 1, maxLength: 256 };
const pagination = {
  offset: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1, maximum: 100 },
};

export const metaTools: Tool[] = [
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
    description:
      "Ranked full-text search over permitted tools (names, paths, descriptions, tags), optionally within a spec. Use * or ? for a glob match.",
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

export function page<T>(items: T[], { offset = 0, limit = 20 }: PageOptions = {}): Page<T> {
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit };
}

export function parseSelection(params = new URLSearchParams()): GatewaySelection {
  for (const key of params.keys()) {
    if (!["mode", "specs", "tools"].includes(key) || params.getAll(key).length !== 1)
      throw new Error("Unknown or repeated gateway parameter");
  }
  const mode = params.get("mode") ?? "meta";
  if (mode !== "meta" && mode !== "tools") throw new Error("mode must be meta or tools");
  const selection: GatewaySelection = { mode };
  for (const key of ["specs", "tools"] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const values = raw.split(",").map((item) => item.trim());
    if (
      values.length > 100 ||
      values.some((item) => !item || item.length > 256 || /[\x00-\x20]/.test(item))
    )
      throw new Error(`Invalid ${key} filter`);
    selection[key] = [...new Set(values)];
  }
  return selection;
}

export function directToolName(id: string): string {
  const prefix = id.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 90);
  return `${prefix}_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

export async function handleMetaTool(
  catalog: ToolCatalog,
  name: string,
  args: JsonObject = {}
): Promise<CallToolResult> {
  const meta = metaTools.find((tool) => tool.name === name);
  if (!meta) throw new Error("Unavailable tool");
  const invalid = validateArguments(meta.inputSchema, args);
  if (invalid) return errorResult(`Invalid arguments: ${invalid}`);
  const paging = args as PageOptions;
  if (name === "list_specs")
    return textResult(
      page(
        catalog.specs().map((entry) => ({
          name: entry.name,
          type: entry._section,
          description: (entry.description || "").slice(0, 240),
        })),
        paging
      )
    );
  if (name === "get_tool") return textResult(await catalog.describe(String(args.tool)));
  if (name === "call_tool")
    return await catalog.call(String(args.tool), args.arguments as JsonObject);
  const spec = args.spec as string | undefined;
  const tools =
    name === "search_tools"
      ? await catalog.search(String(args.query), spec)
      : await catalog.tools(spec);
  return textResult(
    page(
      tools.map((tool) => ({ id: tool.id, description: tool.description.slice(0, 240) })),
      paging
    )
  );
}

export function createGateway(
  selection: GatewaySelection,
  config: ToolScope = {},
  dependencies: GatewayDependencies = {}
): ToolCatalog {
  return createToolCatalog({
    entries: dependencies.entries ?? (() => allEntries(getRegistry())),
    load: dependencies.load,
    execute: dependencies.execute,
    session: dependencies.session,
    scopes: [config, { specs: selection.specs, tools: selection.tools }],
  });
}

export function createGatewayServer(
  selection: GatewaySelection,
  config: ToolScope = {},
  dependencies: GatewayDependencies = {}
): Server {
  const catalog = createGateway(selection, config, dependencies);
  const server = new Server(
    { name: "spec-cli", version: VERSION },
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
      const tools = await catalog.tools();
      const cursor = request.params?.cursor || "0";
      if (!/^\d+$/.test(cursor)) throw new Error("Invalid cursor");
      const offset = Number(cursor);
      const items: Tool[] = [];
      for (const tool of tools.slice(offset, offset + 100)) {
        items.push({
          name: directToolName(tool.id),
          description: `${tool.id}: ${tool.description}`,
          inputSchema: (await catalog.describe(tool)).inputSchema as Tool["inputSchema"],
        });
      }
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
      if (selection.mode === "meta") return await handleMetaTool(catalog, name, args);
      const tool = (await catalog.tools()).find((item) => directToolName(item.id) === name);
      if (!tool) throw new Error("Unavailable tool");
      return await catalog.call(tool.id, args);
    } catch {
      return errorResult("Tool unavailable, blocked by policy, or upstream request failed.");
    }
  });
  return server;
}

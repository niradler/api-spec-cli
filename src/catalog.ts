import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  executeOperation,
  type CallRequest,
  type GraphqlCallResult,
  type McpCallResult,
  type OpenApiCallResult,
} from "./execute.ts";
import { operationQuery, operationSchema } from "./gateway-schema.ts";
import { createMcpSession, type McpSession } from "./mcp-client.ts";
import { isGlob, matchFilter } from "./glob.ts";
import {
  operationId,
  operationMatches,
  operationSearchDocument,
  operations,
  type SpecOperation,
} from "./operations.ts";
import { enforcePolicy } from "./policy.ts";
import { createSearchIndex, type SearchIndex } from "./search.ts";
import { loadSpec } from "./resolve.ts";
import type {
  JsonObject,
  JsonSchema,
  NamedEntry,
  OpenApiOperation,
  SpecDocument,
  ToolFilter,
} from "./types.ts";

export type SpecSelection = string | string[];

export interface ToolScope {
  specs?: string[];
  tools?: string[];
  disabledTools?: string[];
}

export interface CatalogTool {
  id: string;
  spec: string;
  description: string;
  operation: SpecOperation;
  document: SpecDocument;
  entry: NamedEntry;
}

export interface ToolDescription {
  id: string;
  spec: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolCatalogOptions {
  entries: () => NamedEntry[];
  load?: (entry: NamedEntry) => Promise<SpecDocument>;
  execute?: typeof executeOperation;
  scopes?: ToolScope[];
  session?: McpSession;
}

export interface ToolCatalog {
  specs(): NamedEntry[];
  tools(spec?: SpecSelection): Promise<CatalogTool[]>;
  find(id: string): Promise<CatalogTool>;
  describe(tool: string | CatalogTool): Promise<ToolDescription>;
  search(query: string, spec?: SpecSelection): Promise<CatalogTool[]>;
  call(id: string, args?: JsonObject): Promise<CallToolResult>;
  close(): Promise<void>;
}

type ToolArgs = JsonObject & {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
};

export function textResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

export function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

export function validateArguments(schema: JsonSchema, args: unknown): string | null {
  const validation = new AjvJsonSchemaValidator().getValidator(schema)(args);
  return validation.valid ? null : validation.errorMessage || "Invalid arguments";
}

function scopeAllowsSpec(scope: ToolScope, name: string): boolean {
  if (scope.specs && !scope.specs.includes(name)) return false;
  if (scope.tools && !scope.tools.some((tool) => tool.startsWith(`${name}.`))) return false;
  return true;
}

function scopeAllowsTool(scope: ToolScope, id: string): boolean {
  if (scope.tools && !scope.tools.includes(id)) return false;
  return !scope.disabledTools?.includes(id);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryFilter(entry: NamedEntry): ToolFilter {
  return entry._section === "mcp" ? entry : entry.config || {};
}

function entryAllows(filter: ToolFilter, id: string): boolean {
  if (
    filter.allowedTools?.length &&
    !filter.allowedTools.some((pattern) => matchFilter(pattern, id))
  )
    return false;
  return !filter.disabledTools?.some((pattern) => matchFilter(pattern, id));
}

function callRequest(
  document: SpecDocument,
  operation: SpecOperation,
  args: ToolArgs
): CallRequest {
  if (document.type === "openapi") {
    const path = args.path || {};
    const query = args.query || {};
    if (Object.values(path).some((value) => value === "." || value === ".."))
      throw new Error("Invalid path value");
    return {
      exact: true,
      vars: Object.fromEntries(Object.entries(path).map(([key, value]) => [key, String(value)])),
      query: Object.fromEntries(
        Object.entries(query).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(",") : String(value),
        ])
      ),
      queryEntries: operationQuery(document, operation as OpenApiOperation, query),
      ...(Object.hasOwn(args, "body") ? { data: JSON.stringify(args.body) } : {}),
    };
  }
  if (document.type === "graphql")
    return { exact: true, data: { variables: args }, generatedQuery: true };
  return { exact: true, data: args };
}

function toolResult(document: SpecDocument, payload: unknown): CallToolResult {
  if (document.type === "mcp") {
    const result = payload as McpCallResult;
    return result.result || { content: result.content, isError: result.isError };
  }
  if (document.type === "openapi") {
    const { status, body } = payload as OpenApiCallResult;
    return { ...textResult({ status, body }), isError: status >= 400 };
  }
  const { status, data, errors } = payload as GraphqlCallResult;
  return { ...textResult({ status, data, errors }), isError: status >= 400 || Boolean(errors) };
}

export function createToolCatalog(options: ToolCatalogOptions): ToolCatalog {
  const scopes = options.scopes ?? [];
  const session = options.session ?? createMcpSession();
  const loadDocument = options.load ?? ((entry: NamedEntry) => loadSpec(entry));
  const executeRequest = options.execute ?? executeOperation;
  const load = (entry: NamedEntry) => session.run(() => loadDocument(entry));
  const execute: typeof executeOperation = (...args) => session.run(() => executeRequest(...args));

  function specs(): NamedEntry[] {
    return options
      .entries()
      .filter(
        (entry) => entry.enabled && scopes.every((scope) => scopeAllowsSpec(scope, entry.name))
      );
  }

  function selected(spec?: SpecSelection): NamedEntry[] {
    const permitted = specs();
    const names = typeof spec === "string" ? [spec] : spec || [];
    if (names.length === 0) return permitted;
    if (names.some((name) => !permitted.some((entry) => entry.name === name)))
      throw new Error("Unavailable spec");
    return permitted.filter((entry) => names.includes(entry.name));
  }

  async function tools(spec?: SpecSelection): Promise<CatalogTool[]> {
    const found: CatalogTool[] = [];
    for (const entry of selected(spec)) {
      const document = await load(entry);
      const filter = entryFilter(entry);
      for (const operation of operations(document)) {
        if ("kind" in operation && operation.kind === "subscription") continue;
        const name = operationId(document, operation);
        const id = `${entry.name}.${name}`;
        if (!entryAllows(filter, name)) continue;
        if (!scopes.every((scope) => scopeAllowsTool(scope, id))) continue;
        found.push({
          id,
          spec: entry.name,
          description: operation.description || ("summary" in operation && operation.summary) || "",
          operation,
          document,
          entry,
        });
      }
    }
    if (new Set(found.map((tool) => tool.id)).size !== found.length)
      throw new Error("Ambiguous operation IDs");
    return found;
  }

  async function find(id: string): Promise<CatalogTool> {
    const matches: CatalogTool[] = [];
    for (const entry of specs().filter((item) => id.startsWith(`${item.name}.`))) {
      const tool = (await tools(entry.name)).find((item) => item.id === id);
      if (tool) matches.push(tool);
    }
    if (matches.length !== 1) throw new Error("Unavailable tool");
    return matches[0]!;
  }

  async function describe(tool: string | CatalogTool): Promise<ToolDescription> {
    const found = typeof tool === "string" ? await find(tool) : tool;
    return {
      id: found.id,
      spec: found.spec,
      description: found.description,
      inputSchema: operationSchema(found.document, found.operation),
    };
  }

  const searchIndexes = new Map<string, { signature: string; index: SearchIndex }>();

  function searchIndex(scope: string, found: CatalogTool[]): SearchIndex {
    const signature = found.map((tool) => tool.id).join("\n");
    const cached = searchIndexes.get(scope);
    if (cached?.signature === signature) return cached.index;
    const index = createSearchIndex(
      found.map((tool) => operationSearchDocument(tool.id, tool.operation))
    );
    searchIndexes.set(scope, { signature, index });
    return index;
  }

  async function search(query: string, spec?: SpecSelection): Promise<CatalogTool[]> {
    const found = await tools(spec);
    if (isGlob(query)) return found.filter((tool) => operationMatches(tool.operation, query));
    const byId = new Map(found.map((tool) => [tool.id, tool]));
    const scope = [...new Set(typeof spec === "string" ? [spec] : spec || [])].sort().join(",");
    return searchIndex(scope, found)
      .search(query)
      .map((id) => byId.get(id)!);
  }

  async function call(id: string, args: JsonObject = {}): Promise<CallToolResult> {
    const tool = await find(id);
    const invalid = validateArguments(operationSchema(tool.document, tool.operation), args);
    if (invalid) return errorResult(`Invalid arguments: ${invalid}`);
    const toolArgs = args as ToolArgs;
    const target = operationId(tool.document, tool.operation);
    enforcePolicy({
      spec: tool.spec,
      tool: target,
      args: {
        ...toolArgs,
        ...toolArgs.path,
        ...toolArgs.query,
        ...(isObject(toolArgs.body) ? toolArgs.body : {}),
      },
    });
    const request = callRequest(tool.document, tool.operation, toolArgs);
    return toolResult(tool.document, await execute(tool.document, tool.entry, target, request));
  }

  return { specs, tools, find, describe, search, call, close: session.close };
}

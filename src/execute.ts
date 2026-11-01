import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { callCacheKey, getCallCache, setCallCache } from "./cache.ts";
import { buildGraphqlQuery } from "./graphql.ts";
import { createMcpClient } from "./mcp-client.ts";
import {
  promptArguments,
  promptPolicyTarget,
  requirePrompt,
  resolveResourceUri,
  resourcePolicyTargets,
} from "./mcp-features.ts";
import { operationId, requireOperation } from "./operations.ts";
import { filterAllows } from "./glob.ts";
import { enforcePolicy } from "./policy.ts";
import { resolveConfig, type ConfigOptions, type ResolvedConfig } from "./resolve.ts";
import { recordUsage } from "./usage.ts";
import type {
  GraphqlOperation,
  GraphqlSpec,
  McpSpec,
  McpTool,
  OpenApiOperation,
  OpenApiSpec,
  ResolvedEntry,
  SpecDocument,
  StringMap,
} from "./types.ts";

export interface CallRequest extends ConfigOptions {
  data?: unknown;
  vars?: StringMap;
  query?: StringMap;
  queryEntries?: [string, string][];
  method?: string;
  exact?: boolean;
  generatedQuery?: boolean;
}

export interface OpenApiCallResult {
  status: number;
  statusText: string;
  headers: StringMap;
  body: unknown;
}

export interface GraphqlCallResult {
  status: number;
  query: string;
  variables?: Record<string, unknown>;
  data: unknown;
  errors: unknown;
}

export interface McpCallResult {
  tool: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  content: CallToolResult["content"];
  result: CallToolResult;
}

export type CallResult = OpenApiCallResult | GraphqlCallResult | McpCallResult;

export interface McpResourceResult {
  uri: string;
  contents: ReadResourceResult["contents"];
}

export interface McpPromptResult {
  prompt: string;
  arguments: Record<string, string>;
  description: string | null;
  messages: GetPromptResult["messages"];
}

interface CallContext {
  specName: string | undefined;
  request: CallRequest;
  data: string | undefined;
}

function httpTimeout(): number {
  return parseInt(process.env.SPEC_HTTP_TIMEOUT ?? "30000");
}

function registeredName(entry: ResolvedEntry): string | undefined {
  return entry.name && !entry.name.startsWith("inline-") ? entry.name : undefined;
}

function serializeData(data: unknown): string | undefined {
  if (data === undefined || data === null || data === "") return undefined;
  return typeof data === "string" ? data : JSON.stringify(data);
}

function cacheIdentity(ctx: CallContext, fallback: { url?: string; source?: string }): string {
  return ctx.specName || fallback.url || fallback.source || "inline";
}

function cached<T>(keyParts: unknown, ctx: CallContext, operation: string): T | null {
  const hit = getCallCache<T>(callCacheKey(keyParts));
  if (hit) recordUsage(ctx.specName, operation);
  return hit;
}

function store<T>(
  keyParts: unknown,
  ctx: CallContext,
  operation: string,
  payload: T,
  cacheable: boolean
): T {
  if (cacheable) setCallCache(callCacheKey(keyParts), payload, { spec: ctx.specName || null });
  recordUsage(ctx.specName, operation);
  return payload;
}

function policyArgs(ctx: CallContext): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  if (ctx.data) {
    try {
      const parsed = JSON.parse(ctx.data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = { ...parsed };
        if (parsed.variables && typeof parsed.variables === "object")
          args = { ...args, ...parsed.variables };
      }
    } catch {}
  }
  return { ...args, ...ctx.request.query, ...ctx.request.vars };
}

export async function executeOperation(
  spec: SpecDocument,
  entry: ResolvedEntry,
  target: string,
  request: CallRequest = {}
): Promise<CallResult> {
  const ctx = callContext(entry, request);
  const operation = requireOperation(spec, target, { exact: request.exact });
  if (spec.type === "mcp") return callMcp(spec, entry, operation as McpTool, ctx);
  const config = resolveConfig(request, entry);
  enforcePolicy({ spec: ctx.specName, tool: operationId(spec, operation), args: policyArgs(ctx) });
  if (spec.type === "openapi")
    return callOpenApi(spec, entry, config, operation as OpenApiOperation, ctx);
  return callGraphql(spec, config, operation as GraphqlOperation, ctx);
}

type McpResolvedEntry = Extract<ResolvedEntry, { _section: "mcp" }>;

function requireMcpEntry(entry: ResolvedEntry): McpResolvedEntry {
  if (entry._section !== "mcp") throw new Error("MCP spec requires an MCP entry");
  return entry;
}

function mcpArguments(ctx: CallContext, target: string): Record<string, unknown> {
  let args: Record<string, unknown> = {};
  if (ctx.data) {
    try {
      args = JSON.parse(ctx.data);
    } catch {
      throw new Error(`--data must be valid JSON when calling an MCP ${target}`);
    }
  }
  return { ...args, ...ctx.request.vars };
}

function mcpKeyParts(
  entry: McpResolvedEntry,
  ctx: CallContext,
  method: string,
  operation: string,
  data: unknown
) {
  return {
    spec: cacheIdentity(ctx, {
      url: entry.type === "stdio" ? undefined : entry.url,
      source: entry.type === "stdio" ? entry.command : undefined,
    }),
    path:
      entry.type === "stdio"
        ? [entry.command, ...(entry.args || [])].filter(Boolean).join(" ")
        : entry.url,
    method,
    operation,
    vars: ctx.request.vars ?? {},
    query: {},
    data,
    headers: entry.type === "stdio" ? {} : entry.headers || {},
  };
}

async function withMcpClient<T>(entry: McpResolvedEntry, fn: (client: Client) => Promise<T>) {
  const client = await createMcpClient(entry);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function callMcp(
  _spec: McpSpec,
  entry: ResolvedEntry,
  tool: McpTool,
  ctx: CallContext
): Promise<McpCallResult> {
  const mcp = requireMcpEntry(entry);
  const toolArgs = mcpArguments(ctx, "tool");
  enforcePolicy({ spec: ctx.specName, tool: tool.name, args: toolArgs });

  const keyParts = mcpKeyParts(mcp, ctx, "callTool", tool.name, toolArgs);
  const hit = cached<McpCallResult>(keyParts, ctx, tool.name);
  if (hit) return hit;

  const result = (await withMcpClient(mcp, (client) =>
    client.callTool({ name: tool.name, arguments: toolArgs })
  )) as CallToolResult;
  const isError = result.isError === true;
  const payload: McpCallResult = {
    tool: tool.name,
    arguments: toolArgs,
    isError,
    content: result.content,
    result,
  };
  return store(keyParts, ctx, tool.name, payload, !isError);
}

function callContext(entry: ResolvedEntry, request: CallRequest): CallContext {
  return { specName: registeredName(entry), request, data: serializeData(request.data) };
}

export async function readResource(
  spec: SpecDocument,
  entry: ResolvedEntry,
  target: string,
  request: CallRequest = {}
): Promise<McpResourceResult> {
  const ctx = callContext(entry, request);
  const uri = resolveResourceUri(spec, target, request.vars);
  const mcp = requireMcpEntry(entry);
  const targets = resourcePolicyTargets(uri);
  if (!filterAllows(targets, mcp.allowedTools, mcp.disabledTools))
    throw new Error(`Resource not available: ${uri} is excluded by the spec's tool filter`);
  for (const target of targets)
    enforcePolicy({ spec: ctx.specName, tool: target, args: { ...request.vars } });

  const keyParts = mcpKeyParts(mcp, ctx, "readResource", uri, null);
  const hit = cached<McpResourceResult>(keyParts, ctx, uri);
  if (hit) return hit;

  const result = await withMcpClient(mcp, (client) => client.readResource({ uri }));
  return store(keyParts, ctx, uri, { uri, contents: result.contents }, true);
}

export async function getPrompt(
  spec: SpecDocument,
  entry: ResolvedEntry,
  name: string,
  request: CallRequest = {}
): Promise<McpPromptResult> {
  const ctx = callContext(entry, request);
  const prompt = requirePrompt(spec, name);
  const mcp = requireMcpEntry(entry);
  const args = promptArguments(prompt, mcpArguments(ctx, "prompt"));
  enforcePolicy({ spec: ctx.specName, tool: promptPolicyTarget(prompt.name), args });

  const keyParts = mcpKeyParts(mcp, ctx, "getPrompt", prompt.name, args);
  const hit = cached<McpPromptResult>(keyParts, ctx, prompt.name);
  if (hit) return hit;

  const result = await withMcpClient(mcp, (client) =>
    client.getPrompt({ name: prompt.name, arguments: args })
  );
  const payload: McpPromptResult = {
    prompt: prompt.name,
    arguments: args,
    description: result.description || null,
    messages: result.messages,
  };
  return store(keyParts, ctx, prompt.name, payload, true);
}

async function readBody(res: Response): Promise<any> {
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("json") ? await res.json() : await res.text();
}

export function serverUrl(spec: OpenApiSpec, source?: string): string {
  const url = spec.servers?.[0]?.url || "";
  if (!url || /^[a-z][a-z\d+.-]*:/i.test(url) || !source || !/^https?:\/\//i.test(source))
    return url;
  return new URL(url, source).href.replace(/\/$/, "");
}

async function callOpenApi(
  spec: OpenApiSpec,
  entry: ResolvedEntry,
  config: ResolvedConfig,
  op: OpenApiOperation,
  ctx: CallContext
): Promise<OpenApiCallResult> {
  const source = entry._section === "openapi" ? entry.source : undefined;
  const baseUrl = config.baseUrl || serverUrl(spec, source);
  const vars = ctx.request.vars ?? {};
  let path = op.path;
  for (const [key, val] of Object.entries(vars)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(val));
  }

  const missing = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required path parameters: ${missing.join(", ")}. Pass --var ${missing[0]}=<value>`
    );
  }

  const queryParams = ctx.request.query ?? {};
  const qs = new URLSearchParams(ctx.request.queryEntries || queryParams).toString();
  const url = `${baseUrl}${path}${qs ? "?" + qs : ""}`;
  const method = (ctx.request.method || op.method).toUpperCase();
  const headers = { ...config.headers };
  const body = ctx.data;
  if (body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";

  const keyParts = {
    spec: cacheIdentity(ctx, { url: baseUrl }),
    path: url,
    method,
    operation: op.id,
    vars,
    query: queryParams,
    data: body || null,
    headers,
  };
  const hit = cached<OpenApiCallResult>(keyParts, ctx, op.id);
  if (hit) return hit;

  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(httpTimeout()),
  });
  const payload: OpenApiCallResult = {
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: await readBody(res),
  };
  return store(keyParts, ctx, op.id, payload, res.ok);
}

async function callGraphql(
  spec: GraphqlSpec,
  config: ResolvedConfig,
  op: GraphqlOperation,
  ctx: CallContext
): Promise<GraphqlCallResult> {
  const endpoint = config.baseUrl || spec.endpoint;
  if (!endpoint)
    throw new Error("No GraphQL endpoint. Set --base-url or register with --graphql <url>.");

  let query: string;
  let dataVariables: Record<string, unknown> | undefined;
  if (ctx.data) {
    try {
      const parsed = JSON.parse(ctx.data);
      query = parsed.query || ctx.data;
      dataVariables = parsed.variables;
    } catch {
      query = ctx.data;
    }
  } else {
    query = buildGraphqlQuery(op, spec.types);
  }
  if (ctx.request.generatedQuery) query = buildGraphqlQuery(op, spec.types);

  const vars = ctx.request.vars ?? {};
  const variables = { ...dataVariables, ...vars };
  const sentVariables = Object.keys(variables).length > 0 ? variables : undefined;
  const headers = { "Content-Type": "application/json", ...config.headers };

  const keyParts = {
    spec: cacheIdentity(ctx, { url: endpoint, source: spec.endpoint }),
    path: endpoint,
    method: "POST",
    operation: op.name,
    vars,
    query: {},
    data: { query, variables },
    headers,
  };
  const hit = cached<GraphqlCallResult>(keyParts, ctx, op.name);
  if (hit) return hit;

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables: sentVariables }),
    signal: AbortSignal.timeout(httpTimeout()),
  });
  const responseBody = await readBody(res);
  const payload: GraphqlCallResult = {
    status: res.status,
    query,
    variables: sentVariables,
    data: responseBody?.data || null,
    errors: responseBody?.errors || null,
  };
  return store(keyParts, ctx, op.name, payload, res.ok && !responseBody?.errors);
}

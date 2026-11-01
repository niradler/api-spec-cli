import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import {
  executeOperation,
  getPrompt as getMcpPrompt,
  readResource as readMcpResource,
  type CallRequest,
  type GraphqlCallResult,
  type McpCallResult,
  type OpenApiCallResult,
} from "./execute.ts";
import { operationQuery, operationSchema } from "./gateway-schema.ts";
import { createMcpSession, type McpSession } from "./mcp-client.ts";
import { filterAllows, isGlob, matchTemplate } from "./glob.ts";
import { matchesLabels, type LabelMatch } from "./labels.ts";
import {
  operationId,
  operationMatches,
  operationSearchDocument,
  operations,
  type SpecOperation,
} from "./operations.ts";
import {
  promptPolicyTarget,
  resolveResourceUri,
  resourcePolicyTarget,
  resourcePolicyTargets,
} from "./mcp-features.ts";
import { enforcePolicy } from "./policy.ts";
import { createSearchIndex, type SearchIndex } from "./search.ts";
import { loadSpec } from "./resolve.ts";
import type {
  JsonObject,
  JsonSchema,
  McpPromptArgument,
  McpSpec,
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
  labels?: string[];
  labelMatch?: LabelMatch;
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

export interface CatalogResource {
  uri: string;
  spec: string;
  name: string;
  description: string | null;
  mimeType: string | null;
}

export interface CatalogResourceTemplate {
  uriTemplate: string;
  spec: string;
  name: string;
  description: string | null;
  mimeType: string | null;
}

export interface CatalogPrompt {
  name: string;
  spec: string;
  description: string | null;
  arguments: McpPromptArgument[];
}

export interface ToolCatalogOptions {
  entries: () => NamedEntry[];
  load?: (entry: NamedEntry) => Promise<SpecDocument>;
  execute?: typeof executeOperation;
  readResource?: typeof readMcpResource;
  getPrompt?: typeof getMcpPrompt;
  scopes?: ToolScope[];
  session?: McpSession;
}

export interface CatalogSearchOptions {
  unavailable?: (spec: string, error: unknown) => void;
}

const RESOURCE_PREFIX = "spec://";
const NAMESPACED_RESOURCE = /^spec:\/\/([a-zA-Z0-9_-]+)\/(.+)$/s;
const NAMESPACED_PROMPT = /^([a-zA-Z0-9_-]+)\.(.+)$/s;

export function formatResourceUri(spec: string, uri: string): string {
  return `${RESOURCE_PREFIX}${spec}/${uri}`;
}

export function parseResourceUri(uri: string): { spec: string; uri: string } | null {
  const match = NAMESPACED_RESOURCE.exec(uri);
  return match ? { spec: match[1]!, uri: match[2]! } : null;
}

export function formatPromptName(spec: string, name: string): string {
  return `${spec}.${name}`;
}

export function parsePromptName(name: string): { spec: string; name: string } | null {
  const match = NAMESPACED_PROMPT.exec(name);
  return match ? { spec: match[1]!, name: match[2]! } : null;
}

export interface ToolCatalog {
  specs(): NamedEntry[];
  tools(spec?: SpecSelection): Promise<CatalogTool[]>;
  find(id: string): Promise<CatalogTool>;
  describe(tool: string | CatalogTool): Promise<ToolDescription>;
  search(
    query: string,
    spec?: SpecSelection,
    options?: CatalogSearchOptions
  ): Promise<CatalogTool[]>;
  call(id: string, args?: JsonObject): Promise<CallToolResult>;
  resources(spec?: SpecSelection, options?: CatalogSearchOptions): Promise<CatalogResource[]>;
  resourceTemplates(
    spec?: SpecSelection,
    options?: CatalogSearchOptions
  ): Promise<CatalogResourceTemplate[]>;
  readResource(uri: string): Promise<ReadResourceResult>;
  prompts(spec?: SpecSelection, options?: CatalogSearchOptions): Promise<CatalogPrompt[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult>;
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

function scopeAllowsSpec(scope: ToolScope, entry: NamedEntry): boolean {
  if (scope.specs && !scope.specs.includes(entry.name)) return false;
  if (scope.tools && !scope.tools.some((tool) => tool.startsWith(`${entry.name}.`))) return false;
  return matchesLabels(entry, scope.labels, scope.labelMatch);
}

function scopeAllows(scope: ToolScope, ids: string[]): boolean {
  const matches = (patterns: string[], id: string) =>
    patterns.some((pattern) => pattern === id || matchTemplate(pattern, id));
  return ids.every(
    (id) => (!scope.tools || matches(scope.tools, id)) && !matches(scope.disabledTools ?? [], id)
  );
}

function relayMessages(spec: string, messages: GetPromptResult["messages"]) {
  return messages.map((message) => {
    const { content } = message;
    if (content.type === "resource")
      return {
        ...message,
        content: {
          ...content,
          resource: { ...content.resource, uri: formatResourceUri(spec, content.resource.uri) },
        },
      };
    if (content.type === "resource_link")
      return { ...message, content: { ...content, uri: formatResourceUri(spec, content.uri) } };
    return message;
  });
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryFilter(entry: NamedEntry): ToolFilter {
  return entry._section === "mcp" ? entry : entry.config || {};
}

function entryAllows(entry: NamedEntry, ids: string[]): boolean {
  const filter = entryFilter(entry);
  return filterAllows(ids, filter.allowedTools, filter.disabledTools);
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
  const readResourceRequest = options.readResource ?? readMcpResource;
  const getPromptRequest = options.getPrompt ?? getMcpPrompt;

  function specs(): NamedEntry[] {
    return options
      .entries()
      .filter((entry) => entry.enabled && scopes.every((scope) => scopeAllowsSpec(scope, entry)));
  }

  function selected(spec?: SpecSelection): NamedEntry[] {
    const permitted = specs();
    const names = typeof spec === "string" ? [spec] : spec || [];
    if (names.length === 0) return permitted;
    if (names.some((name) => !permitted.some((entry) => entry.name === name)))
      throw new Error("Unavailable spec");
    return permitted.filter((entry) => names.includes(entry.name));
  }

  async function tools(
    spec?: SpecSelection,
    unavailable?: CatalogSearchOptions["unavailable"]
  ): Promise<CatalogTool[]> {
    const found: CatalogTool[] = [];
    for (const entry of selected(spec)) {
      let document: SpecDocument;
      try {
        document = await load(entry);
      } catch (error) {
        if (!unavailable) throw error;
        unavailable(entry.name, error);
        continue;
      }
      for (const operation of operations(document)) {
        if ("kind" in operation && operation.kind === "subscription") continue;
        const name = operationId(document, operation);
        const id = `${entry.name}.${name}`;
        if (!visible(entry, [name])) continue;
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

  async function search(
    query: string,
    spec?: SpecSelection,
    options: CatalogSearchOptions = {}
  ): Promise<CatalogTool[]> {
    const found = await tools(spec, options.unavailable);
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

  async function mcpDocuments(
    spec?: SpecSelection,
    unavailable?: CatalogSearchOptions["unavailable"]
  ): Promise<{ entry: NamedEntry; document: McpSpec }[]> {
    const found: { entry: NamedEntry; document: McpSpec }[] = [];
    for (const entry of selected(spec)) {
      if (entry._section !== "mcp") continue;
      try {
        const document = await load(entry);
        if (document.type === "mcp") found.push({ entry, document });
      } catch (error) {
        if (!unavailable) throw error;
        unavailable(entry.name, error);
      }
    }
    return found;
  }

  function visible(entry: NamedEntry, targets: string[]): boolean {
    const ids = targets.map((target) => `${entry.name}.${target}`);
    return entryAllows(entry, targets) && scopes.every((scope) => scopeAllows(scope, ids));
  }

  function mcpEntry(spec: string): NamedEntry | undefined {
    return specs().find((entry) => entry.name === spec && entry._section === "mcp");
  }

  async function resources(
    spec?: SpecSelection,
    options: CatalogSearchOptions = {}
  ): Promise<CatalogResource[]> {
    const found: CatalogResource[] = [];
    for (const { entry, document } of await mcpDocuments(spec, options.unavailable)) {
      for (const resource of document.resources ?? []) {
        if (!visible(entry, resourcePolicyTargets(resource.uri))) continue;
        found.push({
          ...resource,
          uri: formatResourceUri(entry.name, resource.uri),
          spec: entry.name,
        });
      }
    }
    return found;
  }

  async function resourceTemplates(
    spec?: SpecSelection,
    options: CatalogSearchOptions = {}
  ): Promise<CatalogResourceTemplate[]> {
    const found: CatalogResourceTemplate[] = [];
    for (const { entry, document } of await mcpDocuments(spec, options.unavailable)) {
      for (const template of document.resourceTemplates ?? []) {
        if (!visible(entry, [resourcePolicyTarget(template.uriTemplate)])) continue;
        found.push({
          ...template,
          uriTemplate: formatResourceUri(entry.name, template.uriTemplate),
          spec: entry.name,
        });
      }
    }
    return found;
  }

  async function readResource(uri: string): Promise<ReadResourceResult> {
    const parsed = parseResourceUri(uri);
    const entry = parsed && mcpEntry(parsed.spec);
    if (!parsed || !entry) throw new Error("Unavailable resource");
    const document = await load(entry);
    if (
      document.type !== "mcp" ||
      resolveResourceUri(document, parsed.uri) !== parsed.uri ||
      !visible(entry, resourcePolicyTargets(parsed.uri))
    )
      throw new Error("Unavailable resource");
    const result = await session.run(() => readResourceRequest(document, entry, parsed.uri));
    return {
      contents: result.contents.map((content) => ({
        ...content,
        uri: formatResourceUri(entry.name, content.uri),
      })),
    };
  }

  async function prompts(
    spec?: SpecSelection,
    options: CatalogSearchOptions = {}
  ): Promise<CatalogPrompt[]> {
    const found: CatalogPrompt[] = [];
    for (const { entry, document } of await mcpDocuments(spec, options.unavailable)) {
      for (const prompt of document.prompts ?? []) {
        if (!visible(entry, [promptPolicyTarget(prompt.name)])) continue;
        found.push({
          ...prompt,
          name: formatPromptName(entry.name, prompt.name),
          spec: entry.name,
        });
      }
    }
    return found;
  }

  async function getPrompt(
    name: string,
    args: Record<string, string> = {}
  ): Promise<GetPromptResult> {
    const parsed = parsePromptName(name);
    const entry = parsed && mcpEntry(parsed.spec);
    if (!parsed || !entry) throw new Error("Unavailable prompt");
    const document = await load(entry);
    const prompt =
      document.type === "mcp" ? document.prompts?.find((item) => item.name === parsed.name) : null;
    if (!prompt || !visible(entry, [promptPolicyTarget(prompt.name)]))
      throw new Error("Unavailable prompt");
    const result = await session.run(() =>
      getPromptRequest(document, entry, prompt.name, { data: args })
    );
    return {
      ...(result.description ? { description: result.description } : {}),
      messages: relayMessages(entry.name, result.messages),
    };
  }

  return {
    specs,
    tools,
    find,
    describe,
    search,
    call,
    resources,
    resourceTemplates,
    readResource,
    prompts,
    getPrompt,
    close: session.close,
  };
}

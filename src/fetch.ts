import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { applyToolFilter } from "./glob.ts";
import { flattenType } from "./graphql.ts";
import { createMcpClient } from "./mcp-client.ts";
import { specRequestHeaders } from "./secrets.ts";
import type {
  GraphqlOperation,
  GraphqlOperationKind,
  GraphqlSpec,
  GraphqlType,
  McpPrompt,
  McpResource,
  McpResourceTemplate,
  McpSpec,
  McpTool,
  OpenApiOperation,
  OpenApiSpec,
  ResolvedEntry,
  SpecDocument,
  StringMap,
} from "./types.ts";

export { inlineEntryFromFlags } from "./sources.ts";

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name
      kind
      description
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        type { ...TypeRef }
      }
      inputFields {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
    }
  }
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
      }
    }
  }
}`;

const MAX_ITEMS = 10000;

export async function fetchSpec(entry: ResolvedEntry): Promise<SpecDocument> {
  if (entry._section === "mcp") return await loadMcp(entry);
  const config = entry.config || {};
  if (entry._section === "graphql") {
    const spec = await loadGraphQL(entry.source, specRequestHeaders(config));
    return {
      ...spec,
      operations: applyToolFilter(
        spec.operations,
        (op) => op.name,
        config.allowedTools,
        config.disabledTools
      ),
    };
  }
  const isUrl = entry.source?.startsWith("http://") || entry.source?.startsWith("https://");
  const spec = isUrl
    ? await loadOpenApiUrl(entry.source, specRequestHeaders(config))
    : loadOpenApiFile(entry.source);
  return {
    ...spec,
    operations: applyToolFilter(
      spec.operations,
      (op) => op.id,
      config.allowedTools,
      config.disabledTools
    ),
  };
}

async function listAll<T>(
  kind: string,
  fetchPage: (params: { cursor?: string }) => Promise<{ items: T[]; nextCursor?: string }>
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor ? { cursor } : {});
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || items.length > MAX_ITEMS))
      throw new Error(`Invalid or oversized upstream ${kind} catalog`);
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return items;
}

async function unlessUnsupported<T>(list: () => Promise<T[]>): Promise<T[] | undefined> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof McpError && error.code === ErrorCode.MethodNotFound) return undefined;
    throw error;
  }
}

async function loadMcpResources(client: Client) {
  const resources = await unlessUnsupported(() =>
    listAll("resource", async (params) => {
      const page = await client.listResources(params);
      return {
        nextCursor: page.nextCursor,
        items: page.resources.map((r): McpResource => ({
          uri: r.uri,
          name: r.name,
          description: r.description || null,
          mimeType: r.mimeType || null,
        })),
      };
    })
  );
  const resourceTemplates = await unlessUnsupported(() =>
    listAll("resource template", async (params) => {
      const page = await client.listResourceTemplates(params);
      return {
        nextCursor: page.nextCursor,
        items: page.resourceTemplates.map((t): McpResourceTemplate => ({
          uriTemplate: t.uriTemplate,
          name: t.name,
          description: t.description || null,
          mimeType: t.mimeType || null,
        })),
      };
    })
  );
  return { resources, resourceTemplates };
}

async function loadMcpPrompts(client: Client): Promise<McpPrompt[] | undefined> {
  return await unlessUnsupported(() =>
    listAll("prompt", async (params) => {
      const page = await client.listPrompts(params);
      return {
        nextCursor: page.nextCursor,
        items: page.prompts.map((p): McpPrompt => ({
          name: p.name,
          description: p.description || null,
          arguments: (p.arguments || []).map((a) => ({
            name: a.name,
            description: a.description || null,
            required: a.required === true,
          })),
        })),
      };
    })
  );
}

async function loadMcp(entry: Extract<ResolvedEntry, { _section: "mcp" }>): Promise<McpSpec> {
  const client = await createMcpClient(entry);
  try {
    const tools = await listAll("tool", async (params) => {
      const page = await client.listTools(params);
      return {
        nextCursor: page.nextCursor,
        items: page.tools.map((t): McpTool => ({
          name: t.name,
          description: t.description || null,
          inputSchema: (t.inputSchema as McpTool["inputSchema"]) || null,
        })),
      };
    });
    const capabilities = client.getServerCapabilities() ?? {};
    const { resources, resourceTemplates } = capabilities.resources
      ? await loadMcpResources(client)
      : {};
    const prompts = capabilities.prompts ? await loadMcpPrompts(client) : undefined;

    return {
      type: "mcp",
      title: entry.name || "MCP Server",
      transport: entry.type,
      url: entry.type === "stdio" ? undefined : entry.url,
      command: entry.type === "stdio" ? entry.command : undefined,
      args: entry.type === "stdio" ? entry.args : undefined,
      cwd: entry.type === "stdio" ? entry.cwd : undefined,
      tools: applyToolFilter(tools, (t) => t.name, entry.allowedTools, entry.disabledTools),
      ...(resources ? { resources } : {}),
      ...(resourceTemplates ? { resourceTemplates } : {}),
      ...(prompts ? { prompts } : {}),
    };
  } finally {
    await client.close();
  }
}

async function loadOpenApiUrl(url: string, headers: StringMap): Promise<OpenApiSpec> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return parseOpenAPI(await res.text());
}

function loadOpenApiFile(path: string): OpenApiSpec {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return parseOpenAPI(readFileSync(abs, "utf-8"));
}

interface IntrospectionSchema {
  queryType: { name: string } | null;
  mutationType: { name: string } | null;
  subscriptionType: { name: string } | null;
  types: GraphqlType[];
}

async function loadGraphQL(url: string, headers: StringMap = {}): Promise<GraphqlSpec> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`GraphQL introspection failed: HTTP ${res.status}`);

  const json = (await res.json()) as {
    data?: { __schema: IntrospectionSchema };
    errors?: { message: string }[];
  };
  if (json.errors && !json.data) throw new Error(`GraphQL error: ${json.errors[0]?.message}`);

  const schema = json.data!.__schema;
  const typeMap = new Map(schema.types.map((t) => [t.name, t]));
  const operations: GraphqlOperation[] = [];
  const roots: [GraphqlOperationKind, { name: string } | null][] = [
    ["query", schema.queryType],
    ["mutation", schema.mutationType],
    ["subscription", schema.subscriptionType],
  ];
  for (const [kind, rootType] of roots) {
    if (!rootType) continue;
    for (const field of typeMap.get(rootType.name)?.fields ?? []) {
      operations.push({
        kind,
        name: field.name,
        description: field.description ?? null,
        args: field.args ?? [],
        returnType: flattenType(field.type),
        isDeprecated: field.isDeprecated,
        deprecationReason: field.deprecationReason,
      });
    }
  }

  return {
    type: "graphql",
    title: null,
    endpoint: url,
    operations,
    types: schema.types.filter((t) => !t.name.startsWith("__")),
    raw: schema as unknown as GraphqlSpec["raw"],
  };
}

interface RawOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: unknown[];
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  tags?: string[];
  deprecated?: boolean;
}

interface RawOpenApi {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; description?: string };
  servers?: { url: string }[];
  host?: string;
  basePath?: string;
  schemes?: string[];
  paths?: Record<string, Record<string, RawOperation>>;
  components?: Record<string, unknown>;
  definitions?: Record<string, unknown>;
}

function parseOpenAPI(text: string): OpenApiSpec {
  let doc: RawOpenApi;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = YAML.parse(text);
  }

  const version = doc?.openapi || doc?.swagger;
  if (!version) throw new Error("Not a valid OpenAPI/Swagger spec");

  const operations: OpenApiOperation[] = [];
  for (const [path, methods] of Object.entries(doc.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      if (method.startsWith("x-") || method === "parameters") continue;
      operations.push({
        id: op.operationId || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary || null,
        description: op.description || null,
        parameters: op.parameters || [],
        requestBody: op.requestBody || null,
        responses: op.responses || {},
        tags: op.tags || [],
        deprecated: op.deprecated || false,
      });
    }
  }

  return {
    type: "openapi",
    version,
    title: doc.info?.title || null,
    description: doc.info?.description || null,
    servers:
      doc.servers ||
      (doc.host
        ? [{ url: `${doc.schemes?.[0] || "https"}://${doc.host}${doc.basePath || ""}` }]
        : []),
    operations,
    components: doc.components || doc.definitions || {},
    raw: doc as OpenApiSpec["raw"],
  };
}

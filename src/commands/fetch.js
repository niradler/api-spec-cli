import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import YAML from "yaml";
import { parseKV } from "../args.js";
import { createMcpClient } from "../mcp-client.js";
import { matchFilter } from "../glob.js";

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

function applyFilter(items, nameFn, allowed, disabled) {
  let result = items;
  if (allowed?.length) result = result.filter((item) => allowed.some((p) => matchFilter(p, nameFn(item))));
  if (disabled?.length) result = result.filter((item) => !disabled.some((p) => matchFilter(p, nameFn(item))));
  return result;
}

/**
 * Resolve a spec from a registry entry or inline flags entry.
 * Entry shape:
 *   { type: "openapi", source: "<url-or-file>", config: { headers, auth } }
 *   { type: "graphql", source: "<url>", config: { headers, auth } }
 *   { type: "mcp", transport: "stdio|sse|streamable-http", url?, command?, args?, config: { headers, env } }
 */
export async function fetchSpec(entry) {
  if (entry._section === "mcp") return await loadMCPFromEntry(entry);
  if (entry._section === "graphql") {
    const spec = await loadGraphQL(entry.source, entry.config?.headers);
    return {
      ...spec,
      operations: applyFilter(spec.operations, (op) => op.name, entry.config?.allowedTools, entry.config?.disabledTools),
    };
  }
  // openapi
  const isUrl = entry.source?.startsWith("http://") || entry.source?.startsWith("https://");
  const spec = isUrl ? await loadFromUrl(entry.source, true) : loadFromFile(entry.source);
  return {
    ...spec,
    operations: applyFilter(spec.operations, (op) => op.id, entry.config?.allowedTools, entry.config?.disabledTools),
  };
}

/**
 * Build an inline entry from flags (for ad-hoc commands like --mcp-http <url>).
 * Returns null if no inline source flags present.
 */
export function inlineEntryFromFlags(flags) {
  const allowed = flags["allow-tool"];
  const disabled = flags["disable-tool"];
  const filterConfig = {
    ...(allowed?.length ? { allowedTools: allowed } : {}),
    ...(disabled?.length ? { disabledTools: disabled } : {}),
  };

  if (flags["mcp-stdio"]) {
    const raw = flags["mcp-stdio"];
    const parts = (raw.trim() ? raw.match(/(?:[^\s"]+|"[^"]*")+/g) : null)?.map((p) => p.replace(/^"|"$/g, ""));
    if (!parts?.length) throw new Error("--mcp-stdio requires a non-empty command string");
    return {
      _section: "mcp",
      type: "stdio",
      command: parts[0],
      args: parts.slice(1),
      cwd: flags.cwd,
      env: parseKV(flags.env),
      ...filterConfig,
    };
  }
  if (flags["mcp-sse"]) {
    const headers = parseKV(flags.header);
    if (flags.auth && !headers["Authorization"]) headers["Authorization"] = `Bearer ${flags.auth}`;
    return {
      _section: "mcp",
      type: "sse",
      url: flags["mcp-sse"],
      ...(Object.keys(headers).length ? { headers } : {}),
      ...filterConfig,
    };
  }
  if (flags["mcp-http"]) {
    const headers = parseKV(flags.header);
    if (flags.auth && !headers["Authorization"]) headers["Authorization"] = `Bearer ${flags.auth}`;
    return {
      _section: "mcp",
      type: "http",
      url: flags["mcp-http"],
      ...(Object.keys(headers).length ? { headers } : {}),
      ...filterConfig,
    };
  }
  if (flags.graphql) {
    return { _section: "graphql", type: "graphql", source: flags.graphql, config: { headers: parseKV(flags.header), ...filterConfig } };
  }
  if (flags.openapi) {
    return { _section: "openapi", type: "openapi", source: flags.openapi, config: { headers: parseKV(flags.header), baseUrl: flags["base-url"] || null, ...filterConfig } };
  }
  return null;
}

// --- Internal loaders ---

async function loadMCPFromEntry(entry) {
  const client = await createMcpClient(entry);
  try {
    const { tools } = await client.listTools();
    let mapped = tools.map((t) => ({
      name: t.name,
      description: t.description || null,
      inputSchema: t.inputSchema || null,
    }));

    mapped = applyFilter(mapped, (t) => t.name, entry.allowedTools, entry.disabledTools);

    return {
      type: "mcp",
      title: entry.name || "MCP Server",
      transport: entry.type,
      url: entry.url,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      tools: mapped,
    };
  } finally {
    await client.close();
  }
}

async function loadFromUrl(url, skipGraphQLProbe = false) {
  const lowerUrl = url.toLowerCase();
  const isLikelyFile =
    lowerUrl.endsWith(".json") ||
    lowerUrl.endsWith(".yaml") ||
    lowerUrl.endsWith(".yml");

  if (!isLikelyFile && !skipGraphQLProbe) {
    try {
      return await loadGraphQL(url);
    } catch {
      // Fall through to OpenAPI
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const text = await res.text();
  return parseOpenAPI(text, url);
}

function loadFromFile(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const text = readFileSync(abs, "utf-8");
  return parseOpenAPI(text, path);
}

async function loadGraphQL(url, extraHeaders = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });

  if (!res.ok) throw new Error(`GraphQL introspection failed: HTTP ${res.status}`);

  const json = await res.json();
  if (json.errors && !json.data) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  const schema = json.data.__schema;
  const operations = [];
  const typeMap = {};
  for (const t of schema.types) {
    typeMap[t.name] = t;
  }

  for (const [kind, rootType] of [
    ["query", schema.queryType],
    ["mutation", schema.mutationType],
    ["subscription", schema.subscriptionType],
  ]) {
    if (!rootType) continue;
    const type = typeMap[rootType.name];
    if (!type || !type.fields) continue;
    for (const field of type.fields) {
      operations.push({
        kind,
        name: field.name,
        description: field.description,
        args: field.args,
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
    raw: schema,
  };
}

function parseOpenAPI(text, source) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = YAML.parse(text);
  }

  const version = doc.openapi || doc.swagger;
  if (!version) throw new Error("Not a valid OpenAPI/Swagger spec");

  const operations = [];

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
    servers: doc.servers || (doc.host ? [{ url: `${doc.schemes?.[0] || "https"}://${doc.host}${doc.basePath || ""}` }] : []),
    operations,
    components: doc.components || doc.definitions || {},
    raw: doc,
  };
}

function flattenType(t) {
  if (!t) return null;
  if (t.name) return t.kind === "NON_NULL" ? `${t.name}!` : t.name;
  if (t.ofType) {
    const inner = flattenType(t.ofType);
    if (t.kind === "LIST") return `[${inner}]`;
    if (t.kind === "NON_NULL") return `${inner}!`;
    return inner;
  }
  return t.kind;
}

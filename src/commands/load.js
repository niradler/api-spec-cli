import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import YAML from "yaml";
import { saveSpec } from "../store.js";
import { out, err } from "../output.js";

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

export async function loadSpec(args) {
  const source = args[0];
  if (!source) throw new Error("Usage: spec load <file-or-url>");

  // Detect if it's a URL or file
  const isUrl = source.startsWith("http://") || source.startsWith("https://");

  let spec;

  if (isUrl) {
    spec = await loadFromUrl(source);
  } else {
    spec = loadFromFile(source);
  }

  saveSpec(spec);
  out({
    ok: true,
    type: spec.type,
    title: spec.title || null,
    operationCount: countOperations(spec),
    source: source,
  });
}

async function loadFromUrl(url) {
  // Try GraphQL introspection first if URL doesn't end with known extensions
  const lowerUrl = url.toLowerCase();
  const isLikelyFile =
    lowerUrl.endsWith(".json") ||
    lowerUrl.endsWith(".yaml") ||
    lowerUrl.endsWith(".yml");

  if (!isLikelyFile) {
    // Try GraphQL introspection
    try {
      return await loadGraphQL(url);
    } catch (e) {
      // Fall through to OpenAPI
    }
  }

  // Fetch as OpenAPI
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

async function loadGraphQL(url) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: INTROSPECTION_QUERY }),
  });

  if (!res.ok) throw new Error(`GraphQL introspection failed: HTTP ${res.status}`);

  const json = await res.json();
  if (json.errors && !json.data) {
    throw new Error(`GraphQL error: ${json.errors[0].message}`);
  }

  const schema = json.data.__schema;

  // Extract operations from query/mutation/subscription types
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

  // Detect OpenAPI vs Swagger
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

function countOperations(spec) {
  return spec.operations?.length || 0;
}

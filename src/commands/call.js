import { getSpec, getConfig } from "../store.js";
import { out } from "../output.js";
import { parseArgs, parseKV } from "../args.js";

export async function callOperation(args) {
  const { flags, positional } = parseArgs(args);
  const target = positional[0];
  if (!target) throw new Error("Usage: spec call <operationId-or-path> [--data '{}'] [--query k=v] [--header k=v] [--var k=v] [--method GET]");

  const spec = getSpec();
  if (!spec) throw new Error("No spec loaded. Run: spec load <file-or-url>");

  const config = getConfig();

  if (spec.type === "openapi") {
    await callOpenAPI(spec, config, target, flags);
  } else {
    await callGraphQL(spec, config, target, flags);
  }
}

async function callOpenAPI(spec, config, target, flags) {
  const lower = target.toLowerCase();

  const op = spec.operations.find((o) => {
    return (
      o.id.toLowerCase() === lower ||
      o.path.toLowerCase() === lower ||
      `${o.method.toLowerCase()} ${o.path.toLowerCase()}` === lower
    );
  });

  if (!op) throw new Error(`Operation not found: ${target}`);

  // Build URL
  const baseUrl = config.baseUrl || spec.servers?.[0]?.url || "";
  let path = op.path;

  // Substitute path variables
  const vars = parseKV(flags.var);
  for (const [key, val] of Object.entries(vars)) {
    path = path.replace(`{${key}}`, encodeURIComponent(val));
  }

  // Query params
  const queryParams = parseKV(flags.query);
  const qs = new URLSearchParams(queryParams).toString();
  const url = `${baseUrl}${path}${qs ? "?" + qs : ""}`;

  // Method
  const method = (flags.method || op.method).toUpperCase();

  // Headers
  const headers = {
    ...config.headers,
    ...parseKV(flags.header),
  };

  // Auth
  if (config.auth) {
    if (config.auth.startsWith("Bearer ") || config.auth.startsWith("Basic ")) {
      headers["Authorization"] = config.auth;
    } else {
      headers["Authorization"] = `Bearer ${config.auth}`;
    }
  }

  // Body
  let body = undefined;
  if (flags.data) {
    body = flags.data;
    if (!headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(url, { method, headers, body });
  const contentType = res.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("json")) {
    responseBody = await res.json();
  } else {
    responseBody = await res.text();
  }

  out({
    status: res.status,
    statusText: res.statusText,
    headers: Object.fromEntries(res.headers.entries()),
    body: responseBody,
  });
}

async function callGraphQL(spec, config, target, flags) {
  const lower = target.toLowerCase();

  const op = spec.operations.find((o) => o.name.toLowerCase() === lower);
  if (!op) throw new Error(`Operation not found: ${target}`);

  const endpoint = spec.endpoint;
  if (!endpoint) throw new Error("No GraphQL endpoint set");

  // Build query from operation
  let query;
  if (flags.data) {
    // If --data is provided, treat as raw GraphQL query
    try {
      const parsed = JSON.parse(flags.data);
      query = parsed.query || flags.data;
    } catch {
      query = flags.data;
    }
  } else {
    // Auto-build a simple query/mutation
    query = buildGraphQLQuery(op, spec.types);
  }

  // Variables from --var flags
  const variables = parseKV(flags.var);

  const headers = {
    "Content-Type": "application/json",
    ...config.headers,
    ...parseKV(flags.header),
  };

  if (config.auth) {
    if (config.auth.startsWith("Bearer ") || config.auth.startsWith("Basic ")) {
      headers["Authorization"] = config.auth;
    } else {
      headers["Authorization"] = `Bearer ${config.auth}`;
    }
  }

  const body = JSON.stringify({
    query,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
  });

  const res = await fetch(config.baseUrl || endpoint, { method: "POST", headers, body });
  const responseBody = await res.json();

  out({
    status: res.status,
    query,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
    data: responseBody.data || null,
    errors: responseBody.errors || null,
  });
}

function buildGraphQLQuery(op, types) {
  const args = op.args || [];
  const argsStr = args.length > 0
    ? `(${args.map((a) => `$${a.name}: ${flattenType(a.type)}`).join(", ")})`
    : "";

  const passArgs = args.length > 0
    ? `(${args.map((a) => `${a.name}: $${a.name}`).join(", ")})`
    : "";

  // Try to build a field selection from the return type
  const returnTypeName = op.returnType?.replace(/[[\]!]/g, "");
  const returnType = types?.find((t) => t.name === returnTypeName);
  let fields = "";

  if (returnType?.fields) {
    // Select scalar fields only (1 level deep)
    const scalarFields = returnType.fields
      .filter((f) => {
        const typeName = flattenType(f.type)?.replace(/[[\]!]/g, "");
        const t = types?.find((tt) => tt.name === typeName);
        return !t || t.kind === "SCALAR" || t.kind === "ENUM";
      })
      .map((f) => f.name);

    if (scalarFields.length > 0) {
      fields = ` { ${scalarFields.join(" ")} }`;
    }
  }

  const keyword = op.kind === "mutation" ? "mutation" : "query";
  return `${keyword}${argsStr} { ${op.name}${passArgs}${fields} }`;
}

function flattenType(t) {
  if (!t) return null;
  if (typeof t === "string") return t;
  if (t.name) return t.kind === "NON_NULL" ? `${t.name}!` : t.name;
  if (t.ofType) {
    const inner = flattenType(t.ofType);
    if (t.kind === "LIST") return `[${inner}]`;
    if (t.kind === "NON_NULL") return `${inner}!`;
    return inner;
  }
  return t.kind;
}

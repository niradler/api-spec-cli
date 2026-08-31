import { readFileSync } from "fs";
import { out } from "../output.js";
import { parseArgs, parseKV } from "../args.js";
import { createMcpClient } from "../mcp-client.js";
import { resolveSpec, resolveConfig } from "../resolve.js";
import { recordUsage } from "../usage.js";
import { enforcePolicy, applyPoliciesPath } from "../policy.js";
import { getCallCache, setCallCache, callCacheKey } from "../cache.js";

const HTTP_TIMEOUT = parseInt(process.env.SPEC_HTTP_TIMEOUT ?? "30000");

function specId(flags, entry) {
  return flags.spec || entry?.url || entry?.source || entry?.command || "inline";
}

function cachedCall(keyParts) {
  return getCallCache(callCacheKey(keyParts));
}

function storeCall(keyParts, flags, operationId, payload) {
  setCallCache(callCacheKey(keyParts), payload, { spec: flags.spec || null });
  out(payload);
  recordUsage(flags.spec, operationId);
}

function policyArgs(flags) {
  let args = {};
  if (flags.data) {
    try {
      const parsed = JSON.parse(flags.data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = { ...parsed };
        if (parsed.variables && typeof parsed.variables === "object") {
          args = { ...args, ...parsed.variables };
        }
      }
    } catch {}
  }
  return { ...args, ...parseKV(flags.query), ...parseKV(flags.var) };
}

function assertPolicy(flags, tool) {
  enforcePolicy({ spec: flags.spec, tool, args: policyArgs(flags) });
}

export async function callOperation(args) {
  const { flags, positional } = parseArgs(args);
  applyPoliciesPath(flags);
  const target = positional[0];
  if (!target)
    throw new Error(
      "Usage: spec call <operation> [--spec <name> | --openapi <url> | ...] [--data '{}' | --data -] [--var k=v] [--header k=v]"
    );

  if (flags["data-file"] && !flags.data) {
    flags.data = readFileSync(flags["data-file"], "utf-8").trim();
  }

  // Read from stdin only when --data - is explicitly passed.
  // Agents run in non-TTY environments — auto-detecting stdin would add latency on every call.
  if (flags.data === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    flags.data = Buffer.concat(chunks).toString("utf-8").trim();
  }

  const { spec, entry } = await resolveSpec(flags);
  const config = resolveConfig(flags, entry);

  if (spec.type === "openapi") {
    await callOpenAPI(spec, config, target, flags);
  } else if (spec.type === "mcp") {
    await callMCP(spec, entry, target, flags);
  } else {
    await callGraphQL(spec, config, target, flags);
  }
}

async function callMCP(spec, entry, target, flags) {
  const tool = spec.tools.find((t) => t.name.toLowerCase() === target.toLowerCase());
  if (!tool) throw new Error(`Tool not found: ${target}. Run 'spec list' to see available tools.`);

  let toolArgs = {};
  if (flags.data) {
    try {
      toolArgs = JSON.parse(flags.data);
    } catch {
      throw new Error("--data must be valid JSON when calling an MCP tool");
    }
  }
  const varOverrides = parseKV(flags.var);
  toolArgs = { ...toolArgs, ...varOverrides };

  enforcePolicy({ spec: flags.spec, tool: tool.name, args: toolArgs });

  const keyParts = {
    spec: specId(flags, entry),
    path: entry.url || [entry.command, ...(entry.args || [])].filter(Boolean).join(" ") || "",
    method: "callTool",
    operation: tool.name,
    vars: varOverrides,
    query: {},
    data: toolArgs,
    headers: entry.headers || {},
  };
  const hit = cachedCall(keyParts);
  if (hit) {
    out(hit);
    recordUsage(flags.spec, tool.name);
    if (hit.isError) process.exit(1);
    return;
  }

  const client = await createMcpClient(entry);
  try {
    const result = await client.callTool({ name: tool.name, arguments: toolArgs });
    const isError = result.isError === true;
    const payload = {
      tool: tool.name,
      arguments: toolArgs,
      isError,
      content: result.content,
      result,
    };
    storeCall(keyParts, flags, tool.name, payload);
    if (isError) process.exit(1);
  } finally {
    await client.close();
  }
}

async function callOpenAPI(spec, config, target, flags) {
  const lower = target.toLowerCase();

  const op = spec.operations.find(
    (o) =>
      o.id.toLowerCase() === lower ||
      o.path.toLowerCase() === lower ||
      `${o.method.toLowerCase()} ${o.path.toLowerCase()}` === lower
  );

  if (!op) throw new Error(`Operation not found: ${target}`);

  assertPolicy(flags, op.id);

  const baseUrl = config.baseUrl || spec.servers?.[0]?.url || "";
  let path = op.path;

  const vars = parseKV(flags.var);
  for (const [key, val] of Object.entries(vars)) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(val));
  }

  // Detect unreplaced path parameters and error clearly
  const missing = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required path parameters: ${missing.join(", ")}. Pass --var ${missing[0]}=<value>`
    );
  }

  const queryParams = parseKV(flags.query);
  const qs = new URLSearchParams(queryParams).toString();
  const url = `${baseUrl}${path}${qs ? "?" + qs : ""}`;

  const method = (flags.method || op.method).toUpperCase();
  const headers = { ...config.headers };

  let body = undefined;
  if (flags.data) {
    body = flags.data;
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }

  const keyParts = {
    spec: specId(flags, { url: baseUrl }),
    path: url,
    method,
    operation: op.id,
    vars,
    query: queryParams,
    data: body || null,
    headers,
  };
  const hit = cachedCall(keyParts);
  if (hit) {
    out(hit);
    recordUsage(flags.spec, op.id);
    return;
  }

  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const contentType = res.headers.get("content-type") || "";
  const responseBody = contentType.includes("json") ? await res.json() : await res.text();

  storeCall(keyParts, flags, op.id, {
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

  assertPolicy(flags, op.name);

  const endpoint = config.baseUrl || spec.endpoint;
  if (!endpoint)
    throw new Error("No GraphQL endpoint. Set --base-url or register with --graphql <url>.");

  let query;
  let dataVariables;
  if (flags.data) {
    try {
      const parsed = JSON.parse(flags.data);
      query = parsed.query || flags.data;
      dataVariables = parsed.variables;
    } catch {
      query = flags.data;
    }
  } else {
    query = buildGraphQLQuery(op, spec.types);
  }

  const varOverrides = parseKV(flags.var);
  const variables = { ...dataVariables, ...varOverrides };

  const headers = {
    "Content-Type": "application/json",
    ...config.headers,
  };

  const body = JSON.stringify({
    query,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
  });

  const keyParts = {
    spec: specId(flags, { url: endpoint, source: spec.endpoint }),
    path: endpoint,
    method: "POST",
    operation: op.name,
    vars: varOverrides,
    query: {},
    data: { query, variables },
    headers,
  };
  const hit = cachedCall(keyParts);
  if (hit) {
    out(hit);
    recordUsage(flags.spec, op.name);
    return;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  const contentType = res.headers.get("content-type") || "";
  const responseBody = contentType.includes("json") ? await res.json() : await res.text();

  storeCall(keyParts, flags, op.name, {
    status: res.status,
    query,
    variables: Object.keys(variables).length > 0 ? variables : undefined,
    data: responseBody?.data || null,
    errors: responseBody?.errors || null,
  });
}

function buildGraphQLQuery(op, types) {
  const args = op.args || [];
  const argsStr =
    args.length > 0 ? `(${args.map((a) => `$${a.name}: ${flattenType(a.type)}`).join(", ")})` : "";
  const passArgs =
    args.length > 0 ? `(${args.map((a) => `${a.name}: $${a.name}`).join(", ")})` : "";

  const returnTypeName = op.returnType?.replace(/[[\]!]/g, "");
  const returnType = types?.find((t) => t.name === returnTypeName);
  let fields = "";

  if (returnType?.fields) {
    const scalarFields = returnType.fields
      .filter((f) => {
        const typeName = flattenType(f.type)?.replace(/[[\]!]/g, "");
        const t = types?.find((tt) => tt.name === typeName);
        return !t || t.kind === "SCALAR" || t.kind === "ENUM";
      })
      .map((f) => f.name);

    if (scalarFields.length > 0) fields = ` { ${scalarFields.join(" ")} }`;
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

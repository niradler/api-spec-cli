import { readFileSync } from "fs";
import { out } from "../output.js";
import { parseArgs, parseKV } from "../args.js";
import { createMcpClient } from "../mcp-client.js";
import { resolveActiveSpec, resolveConfig } from "../resolve.js";

export async function callOperation(args) {
  const { flags, positional } = parseArgs(args);
  const target = positional[0];
  if (!target) throw new Error(
    "Usage: spec call <operation> [--spec <name> | --openapi <url> | ...] [--data '{}'] [--var k=v] [--header k=v]"
  );

  if (flags["data-file"] && !flags.data) {
    flags.data = readFileSync(flags["data-file"], "utf-8").trim();
  }

  // Read from stdin when piped and no --data/--data-file provided.
  // isTTY is true in a terminal, undefined when piped — so !isTTY catches piped input.
  // Wrapped in try-catch so test runners with closed stdin don't crash.
  if (!flags.data && !process.stdin.isTTY) {
    try {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const piped = Buffer.concat(chunks).toString("utf-8").trim();
      if (piped) flags.data = piped;
    } catch {
      // stdin unavailable (test runner, closed pipe) — ignore
    }
  }

  const { spec, entry } = await resolveActiveSpec(flags);
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

  // Re-connect using the original entry (which holds transport config + headers/env)
  const client = await createMcpClient(entry);
  try {
    const result = await client.callTool({ name: tool.name, arguments: toolArgs });
    out({ tool: tool.name, arguments: toolArgs, result });
  } finally {
    await client.close();
  }
}

async function callOpenAPI(spec, config, target, flags) {
  const lower = target.toLowerCase();

  const op = spec.operations.find((o) =>
    o.id.toLowerCase() === lower ||
    o.path.toLowerCase() === lower ||
    `${o.method.toLowerCase()} ${o.path.toLowerCase()}` === lower
  );

  if (!op) throw new Error(`Operation not found: ${target}`);

  const baseUrl = config.baseUrl || spec.servers?.[0]?.url || "";
  let path = op.path;

  const vars = parseKV(flags.var);
  for (const [key, val] of Object.entries(vars)) {
    path = path.replace(`{${key}}`, encodeURIComponent(val));
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

  const res = await fetch(url, { method, headers, body });
  const contentType = res.headers.get("content-type") || "";
  const responseBody = contentType.includes("json") ? await res.json() : await res.text();

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

  const endpoint = config.baseUrl || spec.endpoint;
  if (!endpoint) throw new Error("No GraphQL endpoint. Set --base-url or register with --graphql <url>.");

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

  const res = await fetch(endpoint, { method: "POST", headers, body });
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

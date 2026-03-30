import { parseArgs, parseKV } from "../args.js";
import { getRegistry, saveRegistry } from "../registry.js";
import { out } from "../output.js";
import { saveTokenFile } from "../oauth/tokens.js";
import { runOAuthFlow } from "../oauth/auth-flow.js";

export async function addCmd(args) {
  const { flags, positional } = parseArgs(args);
  const name = positional[0];
  if (!name)
    throw new Error(
      'Usage: spec add <name> --openapi <url> | --graphql <url> | --mcp-http <url> | --mcp-sse <url> | --mcp-stdio "<cmd>"'
    );
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Spec name must contain only letters, numbers, hyphens, and underscores.");
  }

  const registry = getRegistry();

  // Check for name collision across all sections
  for (const section of ["mcp", "openapi", "graphql"]) {
    if (registry[section]?.[name]) {
      throw new Error(`Spec '${name}' already exists. Run 'spec remove ${name}' first.`);
    }
  }

  const allowed = flags["allow-tool"];
  const disabled = flags["disable-tool"];
  const filterConfig = {
    ...(allowed?.length ? { allowedTools: allowed } : {}),
    ...(disabled?.length ? { disabledTools: disabled } : {}),
  };
  const base = {
    enabled: true,
    ...(flags.description ? { description: flags.description } : {}),
  };

  // Validate callback port once, shared by both mcp-http and mcp-sse
  let callbackPort;
  if (flags["oauth-callback-port"]) {
    callbackPort = parseInt(flags["oauth-callback-port"], 10);
    if (isNaN(callbackPort) || callbackPort < 1 || callbackPort > 65535) {
      throw new Error("--oauth-callback-port must be an integer between 1 and 65535");
    }
  }

  // Client secret is never stored in the registry — saved to token file below
  const oauthClientSecret = flags["oauth-client-secret"];

  let section, entry;

  if (flags.openapi) {
    section = "openapi";
    entry = {
      ...base,
      type: "openapi",
      source: flags.openapi,
      config: {
        baseUrl: flags["base-url"] || null,
        auth: flags.auth || null,
        headers: parseKV(flags.header),
        ...filterConfig,
      },
    };
  } else if (flags.graphql) {
    section = "graphql";
    entry = {
      ...base,
      type: "graphql",
      source: flags.graphql,
      config: {
        auth: flags.auth || null,
        headers: parseKV(flags.header),
        ...filterConfig,
      },
    };
  } else if (flags["mcp-stdio"]) {
    const raw = flags["mcp-stdio"];
    const parts = (raw.trim() ? raw.match(/(?:[^\s"]+|"[^"]*")+/g) : null)?.map((p) =>
      p.replace(/^"|"$/g, "")
    );
    if (!parts?.length) throw new Error("--mcp-stdio requires a non-empty command string");
    section = "mcp";
    const env = parseKV(flags.env);
    entry = {
      ...base,
      ...filterConfig,
      type: "stdio",
      command: parts[0],
      args: parts.slice(1),
      ...(flags.cwd ? { cwd: flags.cwd } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  } else if (flags["mcp-sse"]) {
    section = "mcp";
    const headers = parseKV(flags.header);
    if (flags.auth && !headers["Authorization"]) headers["Authorization"] = `Bearer ${flags.auth}`;
    entry = {
      ...base,
      ...filterConfig,
      type: "sse",
      url: flags["mcp-sse"],
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(flags["oauth-flow"] ? { oauthFlow: flags["oauth-flow"] } : {}),
      ...(flags["oauth-client-id"] ? { oauthClientId: flags["oauth-client-id"] } : {}),
      ...(callbackPort ? { oauthCallbackPort: callbackPort } : {}),
    };
  } else if (flags["mcp-http"]) {
    section = "mcp";
    const headers = parseKV(flags.header);
    if (flags.auth && !headers["Authorization"]) headers["Authorization"] = `Bearer ${flags.auth}`;
    entry = {
      ...base,
      ...filterConfig,
      type: "http",
      url: flags["mcp-http"],
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(flags["oauth-flow"] ? { oauthFlow: flags["oauth-flow"] } : {}),
      ...(flags["oauth-client-id"] ? { oauthClientId: flags["oauth-client-id"] } : {}),
      ...(callbackPort ? { oauthCallbackPort: callbackPort } : {}),
    };
  } else {
    throw new Error(
      'Specify a source: --openapi <url>, --graphql <url>, --mcp-http <url>, --mcp-sse <url>, or --mcp-stdio "<cmd>"'
    );
  }

  registry[section][name] = entry;
  saveRegistry(registry);

  // Store client secret in token file (not registry) — it's sensitive
  if (oauthClientSecret) {
    saveTokenFile(name, { clientSecret: oauthClientSecret });
  }

  // Probe for OAuth on HTTP/SSE MCP entries (skip if static Authorization header already set)
  if (
    section === "mcp" &&
    (entry.type === "http" || entry.type === "sse") &&
    !entry.headers?.Authorization
  ) {
    await probeAndAuth({ ...entry, name, _section: "mcp" });
  }

  out({ ok: true, name, section, type: entry.type });
}

async function probeAndAuth(entry) {
  try {
    const { flow } = await runOAuthFlow(entry.name, entry);
    if (flow === "none_required") process.stderr.write(`Connected (no auth required).\n`);
    else if (flow === "browser")
      process.stderr.write(`Authorization complete for '${entry.name}'.\n`);
  } catch (e) {
    process.stderr.write(
      `Could not reach server: ${e.message}\nRun 'spec auth ${entry.name}' after the server is available.\n`
    );
    // Signal partial failure: entry was saved but connection failed
    process.exitCode = 1;
  }
}

import { parseArgs, parseKV } from "../args.js";
import { getRegistry, saveRegistry } from "../registry.js";
import { out } from "../output.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { SpecCliOAuthProvider } from "../oauth/provider.js";

export async function addCmd(args) {
  const { flags, positional } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error(
    "Usage: spec add <name> --openapi <url> | --graphql <url> | --mcp-http <url> | --mcp-sse <url> | --mcp-stdio \"<cmd>\""
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
    const parts = (raw.trim() ? raw.match(/(?:[^\s"]+|"[^"]*")+/g) : null)?.map((p) => p.replace(/^"|"$/g, ""));
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
      ...(flags["oauth-client-secret"] ? { oauthClientSecret: flags["oauth-client-secret"] } : {}),
      ...(flags["oauth-callback-port"] ? { oauthCallbackPort: flags["oauth-callback-port"] } : {}),
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
      ...(flags["oauth-client-secret"] ? { oauthClientSecret: flags["oauth-client-secret"] } : {}),
      ...(flags["oauth-callback-port"] ? { oauthCallbackPort: flags["oauth-callback-port"] } : {}),
    };
  } else {
    throw new Error(
      "Specify a source: --openapi <url>, --graphql <url>, --mcp-http <url>, --mcp-sse <url>, or --mcp-stdio \"<cmd>\""
    );
  }

  registry[section][name] = entry;
  saveRegistry(registry);

  // Probe for OAuth on HTTP/SSE MCP entries (skip if static Authorization header already set)
  if (section === "mcp" && (entry.type === "http" || entry.type === "sse") && !entry.headers?.Authorization) {
    await probeAndAuth({ ...entry, name, _section: "mcp" });
  }

  out({ ok: true, name, section, type: entry.type });
}

async function probeAndAuth(entry) {
  const TransportClass = entry.type === "sse" ? SSEClientTransport : StreamableHTTPClientTransport;

  if (entry.oauthClientId && entry.oauthClientSecret) {
    process.stderr.write(`Using client credentials flow for '${entry.name}'...\n`);
    const provider = new ClientCredentialsProvider({
      clientId: entry.oauthClientId,
      clientSecret: entry.oauthClientSecret,
    });
    const transport = new TransportClass(new URL(entry.url), { authProvider: provider });
    const client = new Client({ name: "spec-cli", version: "1.0.0" });
    await client.connect(transport);
    await client.close();
    process.stderr.write(`Connected with client credentials.\n`);
    return;
  }

  const provider = new SpecCliOAuthProvider(entry.name, entry);
  await provider.prepareRedirect();
  const transport = new TransportClass(new URL(entry.url), { authProvider: provider });
  const client = new Client({ name: "spec-cli", version: "1.0.0" });

  try {
    await client.connect(transport);
    await client.close();
    process.stderr.write(`Connected (no auth required).\n`);
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) {
      process.stderr.write(`Could not reach server: ${e.message}\nRun 'spec auth ${entry.name}' after the server is available.\n`);
      return;
    }
    if ((entry.oauthFlow || "browser") !== "browser") {
      throw new Error(
        `Device flow: open the URL above, complete authorization, then run:\n  spec auth ${entry.name}`
      );
    }
    process.stderr.write(`Waiting for browser authorization...\n`);
    const code = await provider.waitForAuthCode();
    await transport.finishAuth(code);
    await client.connect(transport);
    await client.close();
    process.stderr.write(`Authorization complete for '${entry.name}'.\n`);
  }
}

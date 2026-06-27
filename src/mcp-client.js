import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SpecCliOAuthProvider } from "./oauth/provider.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { getClientSecret } from "./oauth/tokens.js";
import { expandSecrets, expandSecretsMap, envHeaderOverrides, envUrlOverride } from "./secrets.js";

const MAX_RETRIES = parseInt(process.env.MCP_MAX_RETRIES ?? "3");
const RETRY_DELAY = parseInt(process.env.MCP_RETRY_DELAY ?? "1000");

function expandEnv(val) {
  return expandSecrets(val);
}

async function connect(spec) {
  const client = new Client({ name: "spec-cli", version: "1.0.0" });

  let transport;
  if (spec.type === "stdio") {
    const rawEnv = spec.env || {};
    const expandedEnv = Object.fromEntries(
      Object.entries(rawEnv).map(([k, v]) => [k, expandEnv(v)])
    );
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: Object.keys(expandedEnv).length > 0 ? { ...process.env, ...expandedEnv } : undefined,
      cwd: spec.cwd,
    });
  } else if (spec.type === "sse") {
    const h = expandSecretsMap({ ...(spec.headers || {}), ...envHeaderOverrides() });
    const url = envUrlOverride() ?? spec.url;
    let authProvider;
    const hasAuthSse = Object.keys(h).some((k) => k.toLowerCase() === "authorization");
    if (spec.name && !hasAuthSse) {
      const clientSecret = getClientSecret(spec.name);
      authProvider =
        spec.oauthFlow === "client_credentials" && spec.oauthClientId && clientSecret
          ? new ClientCredentialsProvider({ clientId: spec.oauthClientId, clientSecret })
          : new SpecCliOAuthProvider(spec.name, spec);
    }
    transport = new SSEClientTransport(new URL(url), {
      authProvider,
      requestInit: Object.keys(h).length > 0 ? { headers: h } : undefined,
    });
  } else if (spec.type === "http") {
    const h = expandSecretsMap({ ...(spec.headers || {}), ...envHeaderOverrides() });
    const url = envUrlOverride() ?? spec.url;
    let authProvider;
    const hasAuthHttp = Object.keys(h).some((k) => k.toLowerCase() === "authorization");
    if (spec.name && !hasAuthHttp) {
      const clientSecret = getClientSecret(spec.name);
      authProvider =
        spec.oauthFlow === "client_credentials" && spec.oauthClientId && clientSecret
          ? new ClientCredentialsProvider({ clientId: spec.oauthClientId, clientSecret })
          : new SpecCliOAuthProvider(spec.name, spec);
    }
    transport = new StreamableHTTPClientTransport(new URL(url), {
      authProvider,
      requestInit: Object.keys(h).length > 0 ? { headers: h } : undefined,
    });
  } else {
    throw new Error(`Unknown MCP type: ${spec.type}. Supported: stdio, sse, http`);
  }

  await client.connect(transport);
  return client;
}

export async function createMcpClient(spec) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await connect(spec);
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.min(RETRY_DELAY * Math.pow(2, attempt), 5000)));
      }
    }
  }
  throw lastError;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { SpecCliOAuthProvider } from "./provider.js";
import { loadTokenFile } from "./tokens.js";

/**
 * Run the full OAuth flow for a named MCP HTTP/SSE entry.
 * Client secret is loaded from the token file (not the registry entry).
 * Returns { flow: "client_credentials" | "browser" | "device" | "none_required" }.
 * Throws on connection errors and unsupported flows.
 */
export async function runOAuthFlow(name, entry) {
  const TransportClass = entry.type === "sse" ? SSEClientTransport : StreamableHTTPClientTransport;
  const clientSecret = loadTokenFile(name).clientSecret;

  if (entry.oauthClientId && clientSecret) {
    process.stderr.write(`Using client credentials flow for '${name}'...\n`);
    const provider = new ClientCredentialsProvider({ clientId: entry.oauthClientId, clientSecret });
    const transport = new TransportClass(new URL(entry.url), { authProvider: provider });
    const client = new Client({ name: "spec-cli", version: "1.0.0" });
    await client.connect(transport);
    await client.close();
    process.stderr.write(`Connected with client credentials.\n`);
    return { flow: "client_credentials" };
  }

  const provider = new SpecCliOAuthProvider(name, entry);
  await provider.prepareRedirect();
  const transport = new TransportClass(new URL(entry.url), { authProvider: provider });
  const client = new Client({ name: "spec-cli", version: "1.0.0" });

  try {
    await client.connect(transport);
    await client.close();
    return { flow: "none_required" };
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    if ((entry.oauthFlow || "browser") !== "browser") {
      throw new Error(
        `Device flow: open the URL above, complete authorization, then run:\n  spec auth ${name}`
      );
    }
    process.stderr.write(`Waiting for browser authorization...\n`);
    const code = await provider.waitForAuthCode();
    await transport.finishAuth(code);
    await client.connect(transport);
    await client.close();
    return { flow: "browser" };
  }
}

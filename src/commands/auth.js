import { parseArgs } from "../args.js";
import { getEntry } from "../registry.js";
import { clearTokenFile } from "../oauth/tokens.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { SpecCliOAuthProvider } from "../oauth/provider.js";
import { out } from "../output.js";

export async function authCmd(args) {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error("Usage: spec auth <name> [--revoke]");

  const entry = getEntry(name);

  if (entry._section !== "mcp" || (entry.type !== "http" && entry.type !== "sse")) {
    throw new Error(`'${name}' is not an HTTP/SSE MCP spec — OAuth only applies to mcp http and sse entries`);
  }

  if (flags.revoke) {
    clearTokenFile(name);
    out({ ok: true, name, revoked: true });
    return;
  }

  clearTokenFile(name);

  const TransportClass = entry.type === "sse" ? SSEClientTransport : StreamableHTTPClientTransport;

  if (entry.oauthClientId && entry.oauthClientSecret) {
    const provider = new ClientCredentialsProvider({
      clientId: entry.oauthClientId,
      clientSecret: entry.oauthClientSecret,
    });
    const transport = new TransportClass(new URL(entry.url), { authProvider: provider });
    const client = new Client({ name: "spec-cli", version: "1.0.0" });
    await client.connect(transport);
    await client.close();
    out({ ok: true, name, flow: "client_credentials" });
    return;
  }

  const provider = new SpecCliOAuthProvider(name, entry);
  await provider.prepareRedirect();
  const transport = new TransportClass(new URL(entry.url), { authProvider: provider });
  const client = new Client({ name: "spec-cli", version: "1.0.0" });

  try {
    await client.connect(transport);
    await client.close();
    out({ ok: true, name, flow: "none_required" });
  } catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    if ((entry.oauthFlow || "browser") !== "browser") {
      throw new Error(`Device flow: open the URL printed above, complete authorization, then run: spec auth ${name}`);
    }
    process.stderr.write(`Waiting for browser authorization...\n`);
    const code = await provider.waitForAuthCode();
    await transport.finishAuth(code);
    await client.connect(transport);
    await client.close();
    out({ ok: true, name, flow: "browser" });
  }
}

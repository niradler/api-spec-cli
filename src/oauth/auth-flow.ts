import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import type { McpRemoteEntry } from "../types.ts";
import { SpecCliOAuthProvider } from "./provider.ts";
import { getClientSecret } from "./tokens.ts";

export interface OAuthFlowResult {
  flow: "client_credentials" | "browser" | "none_required";
}

export type OAuthTarget = Pick<
  McpRemoteEntry,
  "type" | "url" | "oauthFlow" | "oauthClientId" | "oauthCallbackPort"
>;

function transportFor(entry: OAuthTarget, authProvider: OAuthClientProvider) {
  const url = new URL(entry.url);
  return entry.type === "sse"
    ? new SSEClientTransport(url, { authProvider })
    : new StreamableHTTPClientTransport(url, { authProvider });
}

export async function connectOnce(
  entry: OAuthTarget,
  authProvider: OAuthClientProvider
): Promise<void> {
  const client = new Client({ name: "spec-cli", version: "1.0.0" });
  await client.connect(transportFor(entry, authProvider));
  await client.close();
}

export async function runOAuthFlow(name: string, entry: OAuthTarget): Promise<OAuthFlowResult> {
  const clientSecret = getClientSecret(name);

  if (entry.oauthFlow === "client_credentials" && entry.oauthClientId && clientSecret) {
    process.stderr.write(`Using client credentials flow for '${name}'...\n`);
    await connectOnce(
      entry,
      new ClientCredentialsProvider({ clientId: entry.oauthClientId, clientSecret })
    );
    process.stderr.write(`Connected with client credentials.\n`);
    return { flow: "client_credentials" };
  }

  const provider = new SpecCliOAuthProvider(name, entry);
  await provider.prepareRedirect();
  const transport = transportFor(entry, provider);
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
    await connectOnce(entry, provider);
    return { flow: "browser" };
  }
}

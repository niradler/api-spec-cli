import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";
import { McpAuthRequiredError, SpecCliOAuthProvider } from "./oauth/provider.ts";
import { getClientSecret } from "./oauth/tokens.ts";
import {
  envHeaderOverrides,
  envUrlOverride,
  expandSecretsMap,
  hasHeader,
  mergeHeaders,
} from "./secrets.ts";
import type { McpEntry, McpRemoteEntry } from "./types.ts";

export type McpConnectTarget = McpEntry & { name?: string };

export interface McpSessionOptions {
  interactiveAuth?: boolean;
}

export interface McpSession {
  run<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface SessionState {
  clients: Set<Client>;
  interactiveAuth: boolean;
}

const activeClients = new Set<Client>();
const sessionStorage = new AsyncLocalStorage<SessionState>();

async function closeAll(clients: Set<Client>): Promise<void> {
  await Promise.allSettled([...clients].map((client) => client.close()));
}

export async function closeMcpClients(): Promise<void> {
  await closeAll(activeClients);
}

export function createMcpSession({ interactiveAuth = false }: McpSessionOptions = {}): McpSession {
  const state: SessionState = { clients: new Set(), interactiveAuth };
  return {
    run: (fn) => sessionStorage.run(state, fn),
    close: () => closeAll(state.clients),
  };
}

function envInt(name: string, fallback: number): number {
  const value = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isAuthError(error: unknown): boolean {
  return error instanceof UnauthorizedError || error instanceof McpAuthRequiredError;
}

function authProviderFor(
  spec: McpRemoteEntry & { name?: string }
): OAuthClientProvider | undefined {
  if (!spec.name) return undefined;
  const clientSecret = getClientSecret(spec.name);
  return spec.oauthFlow === "client_credentials" && spec.oauthClientId && clientSecret
    ? new ClientCredentialsProvider({ clientId: spec.oauthClientId, clientSecret })
    : new SpecCliOAuthProvider(spec.name, spec, {
        interactive: sessionStorage.getStore()?.interactiveAuth ?? true,
      });
}

function createTransport(spec: McpConnectTarget): Transport {
  if (spec.type === "stdio") {
    const env = expandSecretsMap(spec.env ?? {});
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env:
        Object.keys(env).length > 0
          ? { ...(process.env as Record<string, string>), ...env }
          : undefined,
      cwd: spec.cwd,
    });
  }
  if (spec.type === "sse" || spec.type === "http") {
    const headers = expandSecretsMap(mergeHeaders(spec.headers, envHeaderOverrides()));
    const url = new URL(envUrlOverride() ?? spec.url);
    const options = {
      authProvider: hasHeader(headers, "authorization") ? undefined : authProviderFor(spec),
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    };
    return spec.type === "sse"
      ? new SSEClientTransport(url, options)
      : new StreamableHTTPClientTransport(url, options);
  }
  throw new Error(
    `Unknown MCP type: ${(spec as { type: string }).type}. Supported: stdio, sse, http`
  );
}

async function connect(spec: McpConnectTarget): Promise<Client> {
  const client = new Client({ name: "spec-cli", version: "1.0.0" });
  const transport = createTransport(spec);
  try {
    await client.connect(transport);
    const session = sessionStorage.getStore();
    activeClients.add(client);
    session?.clients.add(client);
    const close = client.close.bind(client);
    client.close = async () => {
      activeClients.delete(client);
      session?.clients.delete(client);
      await close();
    };
    return client;
  } catch (error) {
    await transport.close().catch(() => {});
    throw error;
  }
}

export async function createMcpClient(spec: McpConnectTarget): Promise<Client> {
  const maxRetries = envInt("MCP_MAX_RETRIES", 3);
  const retryDelay = envInt("MCP_RETRY_DELAY", 1000);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await connect(spec);
    } catch (e) {
      lastError = e;
      if (isAuthError(e)) break;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, Math.min(retryDelay * Math.pow(2, attempt), 5000)));
      }
    }
  }
  throw lastError;
}

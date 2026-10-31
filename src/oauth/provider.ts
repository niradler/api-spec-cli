import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthFlow } from "../types.ts";
import { getClientSecret, loadTokenFile, saveTokenFile } from "./tokens.ts";
import { openBrowser } from "./browser.ts";

export interface OAuthEntryOptions {
  oauthFlow?: OAuthFlow;
  oauthClientId?: string;
  oauthCallbackPort?: number | string;
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

export class SpecCliOAuthProvider implements OAuthClientProvider {
  #name: string;
  #flow: OAuthFlow;
  #redirectPort: number | undefined;
  #fixedPort: number | undefined;
  #codeVerifier: string | undefined;
  #pendingCode: Promise<string> | null = null;
  #callbackServer: Server | null = null;
  #oauthState: string | null = null;
  #clientId: string | undefined;

  constructor(name: string, entry: OAuthEntryOptions = {}) {
    this.#name = name;
    this.#flow = entry.oauthFlow || "browser";
    this.#clientId = entry.oauthClientId || undefined;
    const envPort = process.env.SPEC_OAUTH_CALLBACK_PORT
      ? parseInt(process.env.SPEC_OAUTH_CALLBACK_PORT, 10)
      : undefined;
    this.#fixedPort = entry.oauthCallbackPort
      ? parseInt(String(entry.oauthCallbackPort), 10)
      : envPort;
  }

  get redirectUrl(): string | undefined {
    if (this.#flow === "device") return undefined;
    return `http://127.0.0.1:${this.#redirectPort || 0}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const clientSecret = loadTokenFile(this.#name).clientSecret;
    return {
      client_name: "spec-cli",
      redirect_uris: this.#redirectPort ? [`http://127.0.0.1:${this.#redirectPort}/callback`] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: clientSecret ? "client_secret_post" : "none",
    };
  }

  state(): string {
    if (!this.#oauthState) this.#oauthState = randomUUID();
    return this.#oauthState;
  }

  tokens(): OAuthTokens | undefined {
    return loadTokenFile(this.#name).tokens ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    saveTokenFile(this.#name, { tokens });
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const stored = loadTokenFile(this.#name).clientInfo;
    if (stored) return stored;
    if (this.#clientId) {
      const clientSecret = getClientSecret(this.#name);
      return clientSecret
        ? { client_id: this.#clientId, client_secret: clientSecret }
        : { client_id: this.#clientId };
    }
    return undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    saveTokenFile(this.#name, { clientInfo: info });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return loadTokenFile(this.#name).discovery ?? undefined;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    saveTokenFile(this.#name, { discovery: state });
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.#codeVerifier) throw new Error("No code verifier saved");
    return this.#codeVerifier;
  }

  async prepareRedirect(): Promise<void> {
    if (this.#flow === "device") return;
    this.#redirectPort = this.#fixedPort ?? (await getAvailablePort());
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.#flow === "device") {
      process.stderr.write(
        `\nOpen this URL to authorize spec-cli:\n  ${authorizationUrl.toString()}\n\n`
      );
      return;
    }

    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    this.#pendingCode = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.#redirectPort}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Authorization complete. You can close this tab.</h2></body></html>");
      server.close();
      if (this.#oauthState !== null && state !== this.#oauthState) {
        rejectCode(new Error("OAuth state mismatch — possible CSRF attack"));
      } else {
        resolveCode(code as string);
      }
    });
    this.#callbackServer = server;

    server.listen(this.#redirectPort, "127.0.0.1", () => {
      process.stderr.write(`\nOpening browser for authorization...\n`);
      openBrowser(authorizationUrl.toString());
      process.stderr.write(
        `Waiting for callback on http://127.0.0.1:${this.#redirectPort}/callback\n`
      );
    });
  }

  async waitForAuthCode(): Promise<string> {
    if (this.#flow === "device") throw new Error("Device flow does not use a local callback");
    if (!this.#pendingCode) throw new Error("redirectToAuthorization() was not called");

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => {
          this.#callbackServer?.close();
          reject(
            new Error(
              "Authorization timed out after 5 minutes. Run 'spec auth <name>' to try again."
            )
          );
        },
        5 * 60 * 1000
      );
    });

    try {
      return await Promise.race([this.#pendingCode, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

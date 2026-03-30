import { createServer } from "http";
import { spawn } from "child_process";
import { loadTokenFile, saveTokenFile } from "./tokens.js";

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? "cmd" :
    process.platform === "darwin" ? "open" : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

/**
 * OAuthClientProvider for spec-cli.
 * Persists tokens, client registration, and discovery state to
 * ~/spec-cli-config/tokens/<name>.json.
 *
 * Flows:
 *   "browser" (default) — opens browser + local PKCE callback server
 *   "device"            — prints device code URL to stderr
 *
 * For client_credentials, use SDK's ClientCredentialsProvider directly.
 */
export class SpecCliOAuthProvider {
  #name;
  #flow;
  #redirectPort;
  #fixedPort;
  #codeVerifier;
  #pendingCode = null;
  #callbackServer = null;
  #expectedState = null;
  #clientId;

  constructor(name, entry = {}) {
    this.#name = name;
    this.#flow = entry.oauthFlow || "browser";
    this.#clientId = entry.oauthClientId || undefined;
    this.#fixedPort = entry.oauthCallbackPort ? parseInt(entry.oauthCallbackPort, 10) : undefined;
  }

  get redirectUrl() {
    if (this.#flow === "device") return undefined;
    if (!this.#redirectPort) throw new Error("Call prepareRedirect() before accessing redirectUrl");
    return `http://127.0.0.1:${this.#redirectPort}/callback`;
  }

  get clientMetadata() {
    return {
      client_name: "spec-cli",
      redirect_uris: this.#redirectPort ? [`http://127.0.0.1:${this.#redirectPort}/callback`] : [],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  tokens() {
    return loadTokenFile(this.#name).tokens ?? undefined;
  }

  saveTokens(tokens) {
    saveTokenFile(this.#name, { tokens });
  }

  clientInformation() {
    const stored = loadTokenFile(this.#name).clientInfo;
    if (stored) return stored;
    if (this.#clientId) return { client_id: this.#clientId };
    return undefined;
  }

  saveClientInformation(info) {
    saveTokenFile(this.#name, { clientInfo: info });
  }

  discoveryState() {
    return loadTokenFile(this.#name).discovery ?? undefined;
  }

  saveDiscoveryState(state) {
    saveTokenFile(this.#name, { discovery: state });
  }

  saveCodeVerifier(codeVerifier) {
    this.#codeVerifier = codeVerifier;
  }

  codeVerifier() {
    if (!this.#codeVerifier) throw new Error("No code verifier saved");
    return this.#codeVerifier;
  }

  /** Reserve a local port for the OAuth callback. Call before connecting. */
  async prepareRedirect() {
    if (this.#flow === "device") return;
    this.#redirectPort = this.#fixedPort ?? await getAvailablePort();
  }

  redirectToAuthorization(authorizationUrl) {
    if (this.#flow === "device") {
      process.stderr.write(`\nOpen this URL to authorize spec-cli:\n  ${authorizationUrl.toString()}\n\n`);
      return;
    }

    // Capture the state parameter for CSRF validation when the callback arrives
    this.#expectedState = authorizationUrl.searchParams.get("state");

    let resolveCode, rejectCode;
    this.#pendingCode = new Promise((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });

    this.#callbackServer = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${this.#redirectPort}`);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Authorization complete. You can close this tab.</h2></body></html>");
      this.#callbackServer.close();
      if (this.#expectedState && state !== this.#expectedState) {
        rejectCode(new Error("OAuth state mismatch — possible CSRF attack"));
      } else {
        resolveCode(code);
      }
    });

    this.#callbackServer.listen(this.#redirectPort, "127.0.0.1", () => {
      process.stderr.write(`\nOpening browser for authorization...\n`);
      openBrowser(authorizationUrl.toString());
      process.stderr.write(`Waiting for callback on http://127.0.0.1:${this.#redirectPort}/callback\n`);
    });
  }

  /** Resolves with the authorization code once the browser callback arrives. */
  async waitForAuthCode() {
    if (this.#flow === "device") throw new Error("Device flow does not use a local callback");
    if (!this.#pendingCode) throw new Error("redirectToAuthorization() was not called");

    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        this.#callbackServer?.close();
        reject(new Error("Authorization timed out after 5 minutes. Run 'spec auth <name>' to try again."));
      }, 5 * 60 * 1000);
    });

    try {
      return await Promise.race([this.#pendingCode, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

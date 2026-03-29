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
  #codeVerifier;
  #pendingCode;

  constructor(name, entry = {}) {
    this.#name = name;
    this.#flow = entry.oauthFlow || "browser";
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
    return loadTokenFile(this.#name).clientInfo ?? undefined;
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
    this.#redirectPort = await getAvailablePort();
  }

  redirectToAuthorization(authorizationUrl) {
    if (this.#flow === "device") {
      process.stderr.write(`\nOpen this URL to authorize spec-cli:\n  ${authorizationUrl.toString()}\n\n`);
      return;
    }

    let resolveCode;
    this.#pendingCode = new Promise((resolve) => { resolveCode = resolve; });

    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${this.#redirectPort}`);
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h2>Authorization complete. You can close this tab.</h2></body></html>");
      server.close();
      resolveCode(code);
    });

    server.listen(this.#redirectPort, "127.0.0.1", () => {
      process.stderr.write(`\nOpening browser for authorization...\n`);
      openBrowser(authorizationUrl.toString());
      process.stderr.write(`Waiting for callback on http://127.0.0.1:${this.#redirectPort}/callback\n`);
    });
  }

  /** Resolves with the authorization code once the browser callback arrives. */
  async waitForAuthCode() {
    if (this.#flow === "device") throw new Error("Device flow does not use a local callback");
    if (!this.#pendingCode) throw new Error("redirectToAuthorization() was not called");
    return this.#pendingCode;
  }
}

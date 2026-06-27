/**
 * OAuth 2.1 refresh-token round-trip tests.
 *
 * Tests the provider persistence contract (tokens/saveTokens) and the SDK auth()
 * refresh path against a local HTTP mock token endpoint — no live external server needed.
 *
 * SDK source citations are in comments; all line numbers reference
 * node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js at SDK ^1.28.0.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createServer } from "http";
import { mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { setTokenDir, saveTokenFile, loadTokenFile } from "../src/oauth/tokens.js";
import { SpecCliOAuthProvider } from "../src/oauth/provider.js";
import { auth, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";

// ---------------------------------------------------------------------------
// Test directory isolation
// ---------------------------------------------------------------------------
const TEST_DIR = join(tmpdir(), "spec-cli-test-oauth-refresh-" + process.pid);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setTokenDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Local mock token endpoint
// ---------------------------------------------------------------------------

/**
 * Spins up a minimal HTTP server acting as a token endpoint.
 * Responds to POST /token with grant_type=refresh_token.
 * Returns the provided `responseBody` and records the last parsed request body.
 */
function createMockTokenServer(responseBody, statusCode = 200) {
  let lastRequestBody = null;
  let lastRequestHeaders = null;

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      lastRequestBody = Object.fromEntries(new URLSearchParams(body).entries());
      lastRequestHeaders = Object.fromEntries(Object.entries(req.headers));
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify(responseBody));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        server,
        getLastRequest: () => ({ body: lastRequestBody, headers: lastRequestHeaders }),
        close: () => new Promise((res) => server.close(res)),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Provider persistence contract
// ---------------------------------------------------------------------------

describe("SpecCliOAuthProvider — persistence contract (RUNTIME-VERIFIED)", () => {
  test("tokens() returns undefined when no token file exists", () => {
    const provider = new SpecCliOAuthProvider("test", {});
    expect(provider.tokens()).toBeUndefined();
  });

  test("saveTokens() persists full token object including refresh_token and expires_in", () => {
    const provider = new SpecCliOAuthProvider("test", {});
    const tokens = {
      access_token: "old-access",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt-initial",
    };
    provider.saveTokens(tokens);

    const stored = loadTokenFile("test").tokens;
    expect(stored.access_token).toBe("old-access");
    expect(stored.refresh_token).toBe("rt-initial");
    expect(stored.expires_in).toBe(3600);
  });

  test("tokens() returns the full stored object intact (including refresh_token)", () => {
    const tokens = {
      access_token: "at-xyz",
      token_type: "Bearer",
      expires_in: 1800,
      refresh_token: "rt-xyz",
    };
    saveTokenFile("test", { tokens });

    const provider = new SpecCliOAuthProvider("test", {});
    expect(provider.tokens()).toEqual(tokens);
  });

  test("saveTokens() with rotated refresh_token overwrites old tokens atomically", () => {
    // Seed old tokens
    saveTokenFile("test", {
      tokens: { access_token: "old-at", token_type: "Bearer", refresh_token: "old-rt" },
    });

    const provider = new SpecCliOAuthProvider("test", {});
    const rotated = {
      access_token: "new-at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-rt",
    };
    provider.saveTokens(rotated);

    const reloaded = provider.tokens();
    expect(reloaded.access_token).toBe("new-at");
    expect(reloaded.refresh_token).toBe("new-rt");
    // Old refresh_token must NOT survive — saveTokens stores under .tokens key which is fully replaced
    expect(reloaded.refresh_token).not.toBe("old-rt");
  });

  test("saveTokens() does not overwrite other token-file fields (clientInfo, discovery)", () => {
    saveTokenFile("test", {
      clientInfo: { client_id: "cid-123" },
      discovery: { authorizationServerUrl: "https://auth.example.com" },
    });

    const provider = new SpecCliOAuthProvider("test", {});
    provider.saveTokens({ access_token: "at", token_type: "Bearer", refresh_token: "rt" });

    const file = loadTokenFile("test");
    expect(file.clientInfo.client_id).toBe("cid-123");
    expect(file.discovery.authorizationServerUrl).toBe("https://auth.example.com");
    expect(file.tokens.refresh_token).toBe("rt");
  });

  test("second CLI process (fresh provider) picks up refreshed tokens written by first", () => {
    // Simulate: first process saves tokens after refresh
    saveTokenFile("test", {
      tokens: {
        access_token: "refreshed-at",
        token_type: "Bearer",
        refresh_token: "refreshed-rt",
        expires_in: 3600,
      },
      clientInfo: { client_id: "cid" },
    });

    // Second process — new provider instance, reads from disk
    const freshProvider = new SpecCliOAuthProvider("test", {});
    const t = freshProvider.tokens();
    expect(t.access_token).toBe("refreshed-at");
    expect(t.refresh_token).toBe("refreshed-rt");
  });
});

// ---------------------------------------------------------------------------
// SDK refreshAuthorization() against mock token endpoint
// ---------------------------------------------------------------------------

describe("SDK refreshAuthorization() — mock token endpoint (RUNTIME-VERIFIED)", () => {
  test("sends grant_type=refresh_token and correct refresh_token to token endpoint", async () => {
    const newTokens = {
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
    };
    const mock = await createMockTokenServer(newTokens);

    try {
      // SDK auth.js L815: refreshAuthorization builds params with grant_type + refresh_token
      const result = await refreshAuthorization(mock.url, {
        metadata: { token_endpoint: `${mock.url}/token` },
        clientInformation: { client_id: "test-client" },
        refreshToken: "old-refresh-token",
      });

      const req = mock.getLastRequest();
      expect(req.body.grant_type).toBe("refresh_token");
      expect(req.body.refresh_token).toBe("old-refresh-token");
      expect(req.body.client_id).toBe("test-client");

      // SDK auth.js L829: result must include new access_token
      expect(result.access_token).toBe("new-access-token");
      // SDK auth.js L829: new refresh_token from server is returned
      expect(result.refresh_token).toBe("new-refresh-token");
    } finally {
      await mock.close();
    }
  });

  test("SDK preserves original refresh_token when server does not rotate it", async () => {
    // Server returns tokens WITHOUT a refresh_token field
    const serverResponse = {
      access_token: "new-at",
      token_type: "Bearer",
      expires_in: 3600,
      // no refresh_token
    };
    const mock = await createMockTokenServer(serverResponse);

    try {
      // SDK auth.js L829: `return { refresh_token: refreshToken, ...tokens }` — spreads new tokens
      // over the seed; if server omits refresh_token, the original is preserved
      const result = await refreshAuthorization(mock.url, {
        metadata: { token_endpoint: `${mock.url}/token` },
        clientInformation: { client_id: "test-client" },
        refreshToken: "original-rt",
      });

      expect(result.access_token).toBe("new-at");
      expect(result.refresh_token).toBe("original-rt"); // preserved
    } finally {
      await mock.close();
    }
  });

  test("with client_secret — auth method is client_secret_basic by default", async () => {
    const newTokens = { access_token: "at", token_type: "Bearer", expires_in: 3600 };
    const mock = await createMockTokenServer(newTokens);

    try {
      // SDK auth.js L766-768: selectClientAuthMethod prefers client_secret_basic when
      // supportedMethods is empty (server metadata omits token_endpoint_auth_methods_supported)
      await refreshAuthorization(mock.url, {
        metadata: { token_endpoint: `${mock.url}/token` },
        clientInformation: { client_id: "cid", client_secret: "secret123" },
        refreshToken: "rt",
      });

      const req = mock.getLastRequest();
      // Basic auth: credentials NOT in body
      expect(req.body.client_secret).toBeUndefined();
      expect(req.headers.authorization).toMatch(/^Basic /);
    } finally {
      await mock.close();
    }
  });

  test("with client_secret and server advertising client_secret_post — uses post body auth", async () => {
    const newTokens = { access_token: "at", token_type: "Bearer", expires_in: 3600 };
    const mock = await createMockTokenServer(newTokens);

    try {
      // SDK auth.js L47-49: selectClientAuthMethod picks client_secret_post when listed and basic is not
      await refreshAuthorization(mock.url, {
        metadata: {
          token_endpoint: `${mock.url}/token`,
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        },
        clientInformation: { client_id: "cid", client_secret: "secret123" },
        refreshToken: "rt",
      });

      const req = mock.getLastRequest();
      expect(req.body.client_id).toBe("cid");
      expect(req.body.client_secret).toBe("secret123");
      expect(req.headers.authorization).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  test("public client (no secret) — uses none auth method (client_id in body only)", async () => {
    const newTokens = { access_token: "at", token_type: "Bearer", expires_in: 3600 };
    const mock = await createMockTokenServer(newTokens);

    try {
      await refreshAuthorization(mock.url, {
        metadata: { token_endpoint: `${mock.url}/token` },
        clientInformation: { client_id: "public-cid" },
        refreshToken: "rt",
      });

      const req = mock.getLastRequest();
      expect(req.body.client_id).toBe("public-cid");
      expect(req.body.client_secret).toBeUndefined();
      expect(req.headers.authorization).toBeUndefined();
    } finally {
      await mock.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Full provider + SDK auth() refresh path
// ---------------------------------------------------------------------------

describe("SDK auth() refresh path via SpecCliOAuthProvider (RUNTIME-VERIFIED)", () => {
  /**
   * Builds a minimal mock server that handles:
   *   GET /.well-known/oauth-protected-resource  → 404 (no PRM)
   *   GET /.well-known/oauth-authorization-server → returns AS metadata
   *   POST /token                                 → returns new tokens
   */
  function createFullMockAuthServer(newTokens) {
    let tokenRequestBody = null;

    const server = createServer((req, res) => {
      // Discovery: protected resource metadata — not supported, trigger fallback
      if (req.method === "GET" && req.url.includes("oauth-protected-resource")) {
        res.writeHead(404);
        res.end();
        return;
      }

      // Discovery: authorization server metadata
      if (req.method === "GET" && req.url.includes("oauth-authorization-server")) {
        const port = server.address().port;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            issuer: `http://127.0.0.1:${port}`,
            authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
            token_endpoint: `http://127.0.0.1:${port}/token`,
            response_types_supported: ["code"],
          })
        );
        return;
      }

      // Token endpoint
      if (req.method === "POST" && req.url === "/token") {
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          tokenRequestBody = Object.fromEntries(new URLSearchParams(body).entries());
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(newTokens));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        resolve({
          url: `http://127.0.0.1:${port}`,
          server,
          getTokenRequestBody: () => tokenRequestBody,
          close: () => new Promise((res) => server.close(res)),
        });
      });
    });
  }

  test("auth() picks up stored refresh_token, calls token endpoint, persists new tokens via saveTokens()", async () => {
    const rotatedTokens = {
      access_token: "refreshed-at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rotated-rt",
    };

    const mock = await createFullMockAuthServer(rotatedTokens);

    try {
      // Seed expired tokens with a refresh_token — auth() at L274 checks tokens?.refresh_token
      saveTokenFile("test", {
        tokens: {
          access_token: "expired-at",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "stored-rt",
        },
        clientInfo: { client_id: "test-client" },
        discovery: {
          authorizationServerUrl: mock.url + "/",
          authorizationServerMetadata: {
            issuer: mock.url + "/",
            authorization_endpoint: mock.url + "/authorize",
            token_endpoint: mock.url + "/token",
            response_types_supported: ["code"],
          },
        },
      });

      const provider = new SpecCliOAuthProvider("test", {});

      // auth() with no authorizationCode and no redirectUrl triggers refresh path
      // SDK auth.js L272-298: if tokens.refresh_token present → calls refreshAuthorization → saveTokens
      const result = await auth(provider, { serverUrl: new URL(mock.url) });

      expect(result).toBe("AUTHORIZED");

      // Assert: token endpoint received grant_type=refresh_token with correct refresh_token
      const reqBody = mock.getTokenRequestBody();
      expect(reqBody.grant_type).toBe("refresh_token");
      expect(reqBody.refresh_token).toBe("stored-rt");

      // Assert: new tokens were persisted to disk (next CLI process will read them)
      const saved = loadTokenFile("test").tokens;
      expect(saved.access_token).toBe("refreshed-at");
      expect(saved.refresh_token).toBe("rotated-rt");
    } finally {
      await mock.close();
    }
  });

  test("after refresh, second provider instance reads new tokens from disk", async () => {
    const rotatedTokens = {
      access_token: "second-at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "second-rt",
    };

    const mock = await createFullMockAuthServer(rotatedTokens);

    try {
      saveTokenFile("test", {
        tokens: {
          access_token: "old-at",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "old-rt",
        },
        clientInfo: { client_id: "test-client" },
        discovery: {
          authorizationServerUrl: mock.url + "/",
          authorizationServerMetadata: {
            issuer: mock.url + "/",
            authorization_endpoint: mock.url + "/authorize",
            token_endpoint: mock.url + "/token",
            response_types_supported: ["code"],
          },
        },
      });

      const provider = new SpecCliOAuthProvider("test", {});
      await auth(provider, { serverUrl: new URL(mock.url) });

      // Simulate new process — create a fresh provider and check it reads disk
      const nextProvider = new SpecCliOAuthProvider("test", {});
      const t = nextProvider.tokens();
      expect(t.access_token).toBe("second-at");
      expect(t.refresh_token).toBe("second-rt");
    } finally {
      await mock.close();
    }
  });
});

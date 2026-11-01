import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  createSpecClient,
  memoryRegistryStore,
  setCacheDir,
  setSpecHome,
  setTokenDir,
  setUsageDir,
} from "../src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { clearTokenFile, loadTokenFile, saveTokenFile } from "../src/oauth/tokens.ts";
import { startOAuthMcpServer } from "./support/oauth-mcp-server.mjs";

const home = mkdtempSync(join(tmpdir(), "spec-cli-oauth-redirect-"));
const redirectUrl = "https://orc.example.com/api/integrations/connections/secure/oauth/callback";
let stub;

beforeAll(async () => {
  setSpecHome(home);
  setCacheDir(join(home, "cache"));
  setUsageDir(join(home, "usage"));
  setTokenDir(join(home, "tokens"));
  stub = await startOAuthMcpServer();
});

afterAll(async () => {
  await stub.close();
  setSpecHome(undefined);
  setCacheDir(undefined);
  setUsageDir(undefined);
  setTokenDir(undefined);
  rmSync(home, { recursive: true, force: true });
});

function secureClient() {
  const client = createSpecClient({ registry: memoryRegistryStore() });
  client.specs.add("secure", { type: "http", url: stub.url });
  return client;
}

async function approve(authorizationUrl) {
  const response = await fetch(authorizationUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  return new URL(response.headers.get("location"));
}

describe("redirect authorization (dynamic registration + PKCE, no client secret)", () => {
  test("start returns the URL, the host's callback finishes it, and tools load", async () => {
    const client = secureClient();
    const start = await client.specs.startAuthorization("secure", { redirectUrl });
    expect(start.status).toBe("redirect");

    const registration = stub.registrations.at(-1);
    expect(registration.redirect_uris).toEqual([redirectUrl]);
    expect(registration.token_endpoint_auth_method).toBe("none");
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUrl);
    expect(Object.values(loadTokenFile("secure").pending)[0].redirectUrl).toBe(redirectUrl);

    const callback = await approve(start.authorizationUrl);
    expect(`${callback.origin}${callback.pathname}`).toBe(redirectUrl);
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");

    await expect(
      client.specs.finishAuthorization("secure", { code, state: "forged" })
    ).rejects.toThrow("state mismatch");
    await client.specs.finishAuthorization("secure", { code, state });

    const tokenRequest = stub.tokenRequests.at(-1);
    expect(tokenRequest.body.client_secret).toBeUndefined();
    expect(tokenRequest.authorization).toBeUndefined();
    const stored = loadTokenFile("secure");
    expect(stored.tokens?.access_token).toBeTruthy();
    expect(stored.pending).toBeUndefined();

    const mcp = new Client({ name: "check", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(stub.url), {
        requestInit: { headers: { Authorization: `Bearer ${stored.tokens.access_token}` } },
      })
    );
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(["whoami"]);
    await mcp.close();

    await expect(client.specs.finishAuthorization("secure", { code, state })).rejects.toThrow(
      "No sign-in is in progress"
    );
  });

  test("a rejected code exchange clears the pending sign-in", async () => {
    const client = secureClient();
    const start = await client.specs.startAuthorization("secure", { redirectUrl });
    const state = (await approve(start.authorizationUrl)).searchParams.get("state");
    await expect(
      client.specs.finishAuthorization("secure", { code: "not-issued", state })
    ).rejects.toThrow();
    expect(loadTokenFile("secure").pending).toBeUndefined();
  });

  test("existing tokens survive a sign-in that is started but never finished", async () => {
    const client = secureClient();
    saveTokenFile("secure", { tokens: { access_token: "keep", token_type: "Bearer" } });
    const start = await client.specs.startAuthorization("secure", { redirectUrl });
    expect(start.status).toBe("redirect");
    expect(loadTokenFile("secure").tokens?.access_token).toBe("keep");
    clearTokenFile("secure", { revokeAll: true });
  });

  test("overlapping sign-ins each finish with their own state and client", async () => {
    const client = secureClient();
    const first = await client.specs.startAuthorization("secure", { redirectUrl });
    const second = await client.specs.startAuthorization("secure", { redirectUrl });
    const firstCallback = await approve(first.authorizationUrl);
    const secondCallback = await approve(second.authorizationUrl);
    await client.specs.finishAuthorization("secure", {
      code: firstCallback.searchParams.get("code"),
      state: firstCallback.searchParams.get("state"),
    });
    await client.specs.finishAuthorization("secure", {
      code: secondCallback.searchParams.get("code"),
      state: secondCallback.searchParams.get("state"),
    });
    const stored = loadTokenFile("secure");
    expect(stored.tokens?.access_token).toBeTruthy();
    expect(stored.pending).toBeUndefined();
    clearTokenFile("secure", { revokeAll: true });
  });

  test("expired pending sign-ins are not accepted", async () => {
    const client = secureClient();
    const start = await client.specs.startAuthorization("secure", { redirectUrl });
    const callback = await approve(start.authorizationUrl);
    const state = callback.searchParams.get("state");
    const pending = loadTokenFile("secure").pending;
    pending[state].createdAt = Date.now() - 11 * 60 * 1000;
    saveTokenFile("secure", { pending });
    await expect(
      client.specs.finishAuthorization("secure", { code: callback.searchParams.get("code"), state })
    ).rejects.toThrow("No sign-in is in progress");
  });

  test("an invalid redirect URL leaves stored tokens untouched", async () => {
    const client = secureClient();
    saveTokenFile("secure", { tokens: { access_token: "keep", token_type: "Bearer" } });
    await expect(
      client.specs.startAuthorization("secure", { redirectUrl: "not a url" })
    ).rejects.toThrow("Invalid OAuth redirect URL");
    expect(loadTokenFile("secure").tokens?.access_token).toBe("keep");
    clearTokenFile("secure", { revokeAll: true });
  });

  test("client_credentials without a client secret fails instead of opening a browser", async () => {
    const client = createSpecClient({ registry: memoryRegistryStore() });
    client.specs.add("machine", { type: "http", url: stub.url, oauthFlow: "client_credentials" });
    await expect(client.specs.startAuthorization("machine", { redirectUrl })).rejects.toThrow(
      "no client ID and secret"
    );
  });

  test("rejects redirect URLs that are not http(s)", async () => {
    const client = secureClient();
    await expect(
      client.specs.startAuthorization("secure", { redirectUrl: "javascript:alert(1)" })
    ).rejects.toThrow("must use HTTP or HTTPS");
    await expect(
      client.specs.startAuthorization("secure", { redirectUrl: "not a url" })
    ).rejects.toThrow("Invalid OAuth redirect URL");
  });

  test("only applies to remote MCP specs", async () => {
    const client = createSpecClient({ registry: memoryRegistryStore() });
    client.specs.add("local", { type: "stdio", command: "node" });
    await expect(client.specs.startAuthorization("local", { redirectUrl })).rejects.toThrow(
      "OAuth only applies"
    );
  });
});

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
import { loadTokenFile } from "../src/oauth/tokens.ts";
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

/** Plays the user's browser: follow the authorization URL and read the callback it redirects to. */
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
    expect(loadTokenFile("secure").pending?.redirectUrl).toBe(redirectUrl);

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

    // Real SDK client (other test files mock src/mcp-client.ts process-wide) proves the token works.
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

  test("rejects redirect URLs that are not http(s)", async () => {
    const client = secureClient();
    await expect(
      client.specs.startAuthorization("secure", { redirectUrl: "javascript:alert(1)" })
    ).rejects.toThrow("http or https");
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

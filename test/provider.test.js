import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setTokenDir, saveTokenFile, clearTokenFile, loadTokenFile } from "../src/oauth/tokens.js";
import { SpecCliOAuthProvider } from "../src/oauth/provider.js";

const TEST_DIR = join(tmpdir(), "spec-cli-test-provider-" + process.pid);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  setTokenDir(TEST_DIR);
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("SpecCliOAuthProvider.clientInformation()", () => {
  test("returns undefined when no stored info and no clientId", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    expect(provider.clientInformation()).toBeUndefined();
  });

  test("returns { client_id } from entry when no stored info", () => {
    const provider = new SpecCliOAuthProvider("myspec", { oauthClientId: "pre-registered-id" });
    expect(provider.clientInformation()).toEqual({ client_id: "pre-registered-id" });
  });

  test("returns stored clientInfo over entry clientId", () => {
    saveTokenFile("myspec", { clientInfo: { client_id: "dynamic-id", client_secret: "s" } });
    const provider = new SpecCliOAuthProvider("myspec", { oauthClientId: "pre-registered-id" });
    expect(provider.clientInformation()).toEqual({ client_id: "dynamic-id", client_secret: "s" });
  });

  test("saveClientInformation persists to token file", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    provider.saveClientInformation({ client_id: "new-id" });
    expect(loadTokenFile("myspec").clientInfo).toEqual({ client_id: "new-id" });
  });
});

describe("SpecCliOAuthProvider.tokens()", () => {
  test("returns undefined when no token file", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    expect(provider.tokens()).toBeUndefined();
  });

  test("returns stored tokens", () => {
    saveTokenFile("myspec", { tokens: { access_token: "tok123", expires_in: 3600 } });
    const provider = new SpecCliOAuthProvider("myspec", {});
    expect(provider.tokens()).toEqual({ access_token: "tok123", expires_in: 3600 });
  });

  test("saveTokens persists to token file", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    provider.saveTokens({ access_token: "abc" });
    expect(loadTokenFile("myspec").tokens).toEqual({ access_token: "abc" });
  });
});

describe("SpecCliOAuthProvider.discoveryState()", () => {
  test("returns undefined when no discovery saved", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    expect(provider.discoveryState()).toBeUndefined();
  });

  test("saveDiscoveryState and discoveryState round-trip", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    provider.saveDiscoveryState({ issuer: "https://auth.example.com" });
    expect(provider.discoveryState()).toEqual({ issuer: "https://auth.example.com" });
  });
});

describe("clearTokenFile", () => {
  test("preserves clientSecret on normal clear", () => {
    saveTokenFile("myspec", { tokens: { access_token: "tok" }, clientSecret: "secret123" });
    clearTokenFile("myspec");
    expect(loadTokenFile("myspec")).toEqual({ clientSecret: "secret123" });
  });

  test("wipes everything including clientSecret when revokeAll=true", () => {
    saveTokenFile("myspec", { tokens: { access_token: "tok" }, clientSecret: "secret123" });
    clearTokenFile("myspec", { revokeAll: true });
    expect(loadTokenFile("myspec")).toEqual({});
  });

  test("normal clear with no clientSecret removes the file", () => {
    saveTokenFile("myspec", { tokens: { access_token: "tok" } });
    clearTokenFile("myspec");
    expect(loadTokenFile("myspec")).toEqual({});
  });
});

describe("SpecCliOAuthProvider.codeVerifier()", () => {
  test("throws before saveCodeVerifier is called", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    expect(() => provider.codeVerifier()).toThrow("No code verifier saved");
  });

  test("returns saved code verifier", () => {
    const provider = new SpecCliOAuthProvider("myspec", {});
    provider.saveCodeVerifier("verifier-xyz");
    expect(provider.codeVerifier()).toBe("verifier-xyz");
  });
});

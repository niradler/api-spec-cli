import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => {
    captured = data;
  },
  err: (msg) => {
    captured = { error: msg };
  },
}));

const testDir = join(tmpdir(), `spec-cli-test-auth-${process.pid}`);
const REGISTRY_FILE = join(testDir, "registry.json");

function writeRegistry(data) {
  mkdirSync(testDir, { recursive: true });
  writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2));
}

function allEntriesFromReg(registry) {
  const entries = [];
  for (const section of ["mcp", "openapi", "graphql"]) {
    for (const [n, entry] of Object.entries(registry[section] || {})) {
      entries.push({ ...entry, name: n, _section: section });
    }
  }
  return entries;
}

function readReg() {
  if (!existsSync(REGISTRY_FILE)) return { mcp: {}, openapi: {}, graphql: {} };
  return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
}

mock.module("../src/registry.js", () => ({
  getRegistry: () => readReg(),
  saveRegistry: (reg) => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2));
  },
  allEntries: (registry) => allEntriesFromReg(registry),
  getEntry: (name) => {
    const reg = readReg();
    const entry = allEntriesFromReg(reg).find((e) => e.name === name);
    if (!entry) throw new Error(`No spec named '${name}'.`);
    if (!entry.enabled) throw new Error(`Spec '${name}' is disabled.`);
    return entry;
  },
  getCachedSpec: () => null,
  saveCachedSpec: () => {},
  removeCachedSpec: () => {},
}));

// Token dir in temp directory
import { setTokenDir, loadTokenFile, saveTokenFile } from "../src/oauth/tokens.js";
const TOKEN_DIR = join(testDir, "tokens");

// Mock runOAuthFlow so auth tests don't need a real server
mock.module("../src/oauth/auth-flow.js", () => ({
  runOAuthFlow: async (_name, _entry) => ({ flow: "browser" }),
}));

const { authCmd } = await import("../src/commands/auth.js");

beforeEach(() => {
  captured = null;
  mkdirSync(TOKEN_DIR, { recursive: true });
  setTokenDir(TOKEN_DIR);
  writeRegistry({ mcp: {}, openapi: {}, graphql: {} });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("spec auth", () => {
  test("--revoke clears token file and returns revoked:true", async () => {
    writeRegistry({
      mcp: { myapi: { type: "http", url: "https://example.com/mcp", enabled: true } },
      openapi: {},
      graphql: {},
    });
    saveTokenFile("myapi", { tokens: { access_token: "tok" }, clientSecret: "sec" });
    await authCmd(["myapi", "--revoke"]);
    expect(captured).toEqual({ ok: true, name: "myapi", revoked: true });
    // revokeAll should wipe everything including clientSecret
    expect(loadTokenFile("myapi")).toEqual({});
  });

  test("throws for non-mcp entry", async () => {
    writeRegistry({
      mcp: {},
      openapi: {
        pets: { type: "openapi", source: "https://example.com/spec.json", enabled: true },
      },
      graphql: {},
    });
    await expect(authCmd(["pets"])).rejects.toThrow(
      "OAuth only applies to mcp http and sse entries"
    );
  });

  test("throws for mcp stdio entry", async () => {
    writeRegistry({
      mcp: { fs: { type: "stdio", command: "npx", args: [], enabled: true } },
      openapi: {},
      graphql: {},
    });
    await expect(authCmd(["fs"])).rejects.toThrow("OAuth only applies to mcp http and sse entries");
  });

  test("throws when spec not found", async () => {
    await expect(authCmd(["doesnotexist"])).rejects.toThrow("No spec named");
  });

  test("throws without name argument", async () => {
    await expect(authCmd([])).rejects.toThrow("Usage: spec auth");
  });

  test("re-auth preserves clientSecret", async () => {
    writeRegistry({
      mcp: { myapi: { type: "http", url: "https://example.com/mcp", enabled: true } },
      openapi: {},
      graphql: {},
    });
    saveTokenFile("myapi", { tokens: { access_token: "old" }, clientSecret: "mysecret" });
    await authCmd(["myapi"]);
    expect(captured.ok).toBe(true);
    // clientSecret should survive the clearTokenFile call inside authCmd
    expect(loadTokenFile("myapi").clientSecret).toBe("mysecret");
  });

  test("successful auth returns flow from runOAuthFlow", async () => {
    writeRegistry({
      mcp: { myapi: { type: "sse", url: "https://example.com/mcp", enabled: true } },
      openapi: {},
      graphql: {},
    });
    await authCmd(["myapi"]);
    expect(captured).toEqual({ ok: true, name: "myapi", flow: "browser" });
  });
});

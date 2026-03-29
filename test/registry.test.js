import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => { captured = data; },
  err: (msg) => { captured = { error: msg }; },
}));

// Use a temp dir for the registry during tests
const testRegistryDir = join(tmpdir(), `spec-cli-test-${process.pid}`);
const REGISTRY_FILE = join(testRegistryDir, "registry.json");
const CACHE_DIR = join(testRegistryDir, "cache");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Synchronous factory — avoids async deadlock when multiple test workers run in parallel
mock.module("../src/registry.js", () => ({
  getRegistry: () => {
    if (!existsSync(REGISTRY_FILE)) return [];
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
  },
  saveRegistry: (entries) => {
    ensureDir(testRegistryDir);
    writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
  },
  getEntry: (name) => {
    const registry = existsSync(REGISTRY_FILE) ? JSON.parse(readFileSync(REGISTRY_FILE, "utf-8")) : [];
    const entry = registry.find((e) => e.name === name);
    if (!entry) throw new Error(`No spec named '${name}'.`);
    if (!entry.enabled) throw new Error(`Spec '${name}' is disabled.`);
    return entry;
  },
  getCachedSpec: (_name) => null,
  saveCachedSpec: (_name, _spec) => {},
  removeCachedSpec: (name) => {
    const file = join(CACHE_DIR, `${name}.json`);
    if (existsSync(file)) rmSync(file);
  },
}));

// Mock fetchSpec so refresh doesn't actually connect
mock.module("../src/commands/fetch.js", () => ({
  fetchSpec: async (entry) => ({
    type: entry.type || "mcp",
    tools: [{ name: "test_tool", description: "A test tool", inputSchema: null }],
  }),
  inlineEntryFromFlags: () => null,
}));

const { addCmd } = await import("../src/commands/add.js");
const { specsCmd, registryMutate } = await import("../src/commands/specs.js");

beforeEach(() => {
  captured = null;
  // Clean test registry dir
  if (existsSync(testRegistryDir)) rmSync(testRegistryDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testRegistryDir)) rmSync(testRegistryDir, { recursive: true });
});

describe("spec add", () => {
  test("adds an MCP HTTP entry", async () => {
    await addCmd(["myapi", "--mcp-http", "https://example.com/mcp", "--description", "Test API"]);
    expect(captured.ok).toBe(true);
    expect(captured.name).toBe("myapi");
    expect(captured.type).toBe("mcp");
    expect(captured.transport).toBe("streamable-http");
  });

  test("adds an OpenAPI entry", async () => {
    await addCmd(["pets", "--openapi", "https://petstore.com/openapi.json", "--base-url", "https://petstore.com/api"]);
    expect(captured.ok).toBe(true);
    expect(captured.name).toBe("pets");
    expect(captured.type).toBe("openapi");
  });

  test("adds a GraphQL entry", async () => {
    await addCmd(["gql", "--graphql", "https://api.example.com/graphql", "--auth", "mytoken"]);
    expect(captured.ok).toBe(true);
    expect(captured.type).toBe("graphql");
  });

  test("adds a stdio MCP entry with env vars", async () => {
    await addCmd(["fs", "--mcp-stdio", "npx -y server /tmp", "--env", "SECRET=abc"]);
    expect(captured.ok).toBe(true);
    expect(captured.transport).toBe("stdio");
  });

  test("adds a stdio MCP entry with --cwd", async () => {
    await addCmd(["fs2", "--mcp-stdio", "npx -y server /tmp", "--cwd", "/my/project"]);
    expect(captured.ok).toBe(true);
    // Verify cwd is stored in registry
    const { getRegistry } = await import("../src/registry.js");
    const entry = getRegistry().find((e) => e.name === "fs2");
    expect(entry.cwd).toBe("/my/project");
  });

  test("stores allowedTools and disabledTools for MCP entry", async () => {
    await addCmd([
      "filtered", "--mcp-http", "https://example.com/mcp",
      "--allow-tool", "read_*",
      "--allow-tool", "list_*",
      "--disable-tool", "delete_*",
    ]);
    expect(captured.ok).toBe(true);
    const { getRegistry } = await import("../src/registry.js");
    const entry = getRegistry().find((e) => e.name === "filtered");
    expect(entry.config.allowedTools).toEqual(["read_*", "list_*"]);
    expect(entry.config.disabledTools).toEqual(["delete_*"]);
  });

  test("rejects invalid spec name (path chars)", async () => {
    await expect(addCmd(["bad/name", "--mcp-http", "https://example.com/mcp"])).rejects.toThrow("letters, numbers");
  });

  test("rejects --mcp-stdio with empty command", async () => {
    await expect(addCmd(["fs3", "--mcp-stdio", "   "])).rejects.toThrow("non-empty command");
  });

  test("rejects duplicate names", async () => {
    await addCmd(["myapi", "--mcp-http", "https://example.com/mcp"]);
    captured = null;
    await expect(addCmd(["myapi", "--mcp-http", "https://example.com/mcp"])).rejects.toThrow("already exists");
  });

  test("rejects missing source flag", async () => {
    await expect(addCmd(["myapi", "--description", "no source"])).rejects.toThrow("Specify a source");
  });

  test("rejects missing name", async () => {
    await expect(addCmd([])).rejects.toThrow("Usage");
  });
});

describe("spec specs", () => {
  beforeEach(async () => {
    await addCmd(["agno", "--mcp-http", "https://docs.agno.com/mcp", "--description", "Agno"]);
    await addCmd(["petstore", "--openapi", "https://petstore.com/openapi.json"]);
    captured = null;
  });

  test("lists all entries compact", async () => {
    await specsCmd([]);
    expect(captured.specs).toHaveLength(2);
    expect(captured.specs[0].name).toBe("agno");
    expect(captured.specs[0].type).toBe("mcp");
    expect(captured.specs[0].enabled).toBe(true);
    // compact: no config, no source
    expect(captured.specs[0].config).toBeUndefined();
  });

  test("--compact false shows full entries", async () => {
    await specsCmd(["--compact", "false"]);
    expect(captured.specs[0].config).toBeDefined();
    expect(captured.specs[1].source).toBe("https://petstore.com/openapi.json");
  });
});

describe("spec enable / disable / remove", () => {
  beforeEach(async () => {
    await addCmd(["agno", "--mcp-http", "https://docs.agno.com/mcp"]);
    captured = null;
  });

  test("disables an entry", async () => {
    await registryMutate("disable", ["agno"]);
    expect(captured.ok).toBe(true);
    expect(captured.disabled).toBe("agno");
  });

  test("enables a disabled entry", async () => {
    await registryMutate("disable", ["agno"]);
    await registryMutate("enable", ["agno"]);
    expect(captured.ok).toBe(true);
    expect(captured.enabled).toBe("agno");
  });

  test("removes an entry", async () => {
    await registryMutate("remove", ["agno"]);
    expect(captured.ok).toBe(true);
    expect(captured.removed).toBe("agno");
    captured = null;
    await specsCmd([]);
    expect(captured.specs).toHaveLength(0);
  });

  test("refresh re-fetches and caches", async () => {
    await registryMutate("refresh", ["agno"]);
    expect(captured.ok).toBe(true);
    expect(captured.refreshed).toBe("agno");
    expect(captured.count).toBe(1);
  });

  test("remove on unknown name throws", async () => {
    await expect(registryMutate("remove", ["doesnotexist"])).rejects.toThrow("No spec named");
  });
});

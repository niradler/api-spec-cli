import { describe, test, expect, beforeEach, mock } from "bun:test";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => { captured = data; },
  err: (msg) => { captured = { error: msg }; },
}));

// Registry mock with in-memory entries + cache
let registryEntries = {};
let specCache = {};

function allEntriesFromMock(registry) {
  const out = [];
  for (const section of ["mcp", "openapi", "graphql"]) {
    for (const [name, entry] of Object.entries(registry[section] || {})) {
      out.push({ ...entry, name, _section: section });
    }
  }
  return out;
}

mock.module("../src/registry.js", () => ({
  getRegistry: () => registryEntries,
  saveRegistry: () => {},
  allEntries: (registry) => allEntriesFromMock(registry),
  getEntry: (name) => {
    const e = allEntriesFromMock(registryEntries).find((e) => e.name === name);
    if (!e) throw new Error(`No spec named '${name}'`);
    if (!e.enabled) throw new Error(`Spec '${name}' is disabled`);
    return e;
  },
  getCachedSpec: (name) => specCache[name] || null,
  saveCachedSpec: (name, spec) => { specCache[name] = spec; },
  removeCachedSpec: () => {},
}));

// No mock for fetch.js — grepCmd uses getCachedSpec (all specs pre-loaded in specCache)
// so fetchSpec is never called. matchGlob comes from src/glob.js (real, no mock).

const { grepCmd } = await import("../src/commands/grep.js");

const MCP_SPEC = {
  type: "mcp",
  tools: [
    { name: "search_docs", description: "Search documentation pages" },
    { name: "get_page", description: "Fetch a page by URL" },
    { name: "delete_cache", description: "Clear server cache" },
  ],
};

const OPENAPI_SPEC = {
  type: "openapi",
  operations: [
    { id: "listPets", method: "GET", path: "/pets", summary: "List all pets" },
    { id: "getPet", method: "GET", path: "/pets/{petId}", summary: "Get one pet" },
    { id: "createPet", method: "POST", path: "/pets", summary: "Create a pet" },
  ],
};

const GQL_SPEC = {
  type: "graphql",
  operations: [
    { name: "me", kind: "query", description: "Get current user" },
    { name: "createPost", kind: "mutation", description: "Create a post" },
  ],
};

beforeEach(() => {
  captured = null;
  registryEntries = {
    mcp: { mymcp: { type: "mcp", enabled: true } },
    openapi: { myapi: { type: "openapi", enabled: true } },
    graphql: { mygql: { type: "graphql", enabled: true } },
  };
  specCache = {
    mymcp: MCP_SPEC,
    myapi: OPENAPI_SPEC,
    mygql: GQL_SPEC,
  };
});

describe("grep - substring matching", () => {
  test("matches MCP tool by name substring", async () => {
    await grepCmd(["search"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult).toBeDefined();
    expect(mcpResult.matches).toHaveLength(1);
    expect(mcpResult.matches[0].id).toBe("search_docs");
  });

  test("matches MCP tool by description substring", async () => {
    await grepCmd(["page"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches.map((m) => m.id)).toContain("get_page");
  });

  test("matches OpenAPI operation by id", async () => {
    await grepCmd(["createPet"]);
    const apiResult = captured.results.find((r) => r.spec === "myapi");
    expect(apiResult.matches[0].id).toBe("createPet");
  });

  test("matches OpenAPI operation by path", async () => {
    await grepCmd(["petId"]);
    const apiResult = captured.results.find((r) => r.spec === "myapi");
    expect(apiResult.matches[0].id).toBe("getPet");
  });

  test("matches GraphQL operation by name", async () => {
    await grepCmd(["create"]);
    const gqlResult = captured.results.find((r) => r.spec === "mygql");
    expect(gqlResult.matches[0].id).toBe("createPost");
  });

  test("case insensitive", async () => {
    await grepCmd(["SEARCH"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches[0].id).toBe("search_docs");
  });

  test("total counts all matches across specs", async () => {
    await grepCmd(["e"]); // matches everything with 'e'
    expect(captured.total).toBeGreaterThan(3);
  });
});

describe("grep - glob patterns", () => {
  test("* glob matches multiple tools", async () => {
    await grepCmd(["*_docs"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches[0].id).toBe("search_docs");
  });

  test("* prefix glob", async () => {
    await grepCmd(["get*"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches.map((m) => m.id)).toContain("get_page");
  });

  test("no match returns empty results", async () => {
    await grepCmd(["zzz_nonexistent_zzz"]);
    expect(captured.total).toBe(0);
    expect(captured.results).toHaveLength(0);
  });
});

describe("grep - --spec filter", () => {
  test("narrows to one spec", async () => {
    await grepCmd(["search", "--spec", "mymcp"]);
    expect(captured.results).toHaveLength(1);
    expect(captured.results[0].spec).toBe("mymcp");
  });

  test("skips disabled specs when searching all", async () => {
    registryEntries.mcp.mymcp.enabled = false; // disable mymcp
    await grepCmd(["search"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult).toBeUndefined();
  });

  test("throws on missing pattern", async () => {
    await expect(grepCmd([])).rejects.toThrow("Usage");
  });
});

import { describe, test, expect, beforeEach, mock } from "bun:test";

let captured;
const realOutput = { ...(await import("../src/output.ts")) };
mock.module("../src/output.ts", () => ({
  ...realOutput,
  out: (data) => {
    captured = data;
  },
  err: (msg) => {
    captured = { error: msg };
  },
}));

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

const realRegistry = { ...(await import("../src/registry.ts")) };
const registryMock = {
  ...realRegistry,
  getRegistry: () => registryEntries,
  saveRegistry: () => {},
  allEntries: (registry) => allEntriesFromMock(registry),
  getEntry: (name, registry = registryMock.getRegistry()) => realRegistry.getEntry(name, registry),
};
registryMock.fileRegistryStore = () => ({
  read: registryMock.getRegistry,
  write: registryMock.saveRegistry,
});
mock.module("../src/registry.ts", () => registryMock);

const realResolve = { ...(await import("../src/resolve.ts")) };
mock.module("../src/resolve.ts", () => ({
  ...realResolve,
  loadSpec: async (entry, options) => specCache[entry.name] ?? realResolve.loadSpec(entry, options),
}));

const { searchCmd } = await import("../src/commands/search.ts");

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

describe("search - ranked text", () => {
  test("matches MCP tool by name substring", async () => {
    await searchCmd(["search"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult).toBeDefined();
    expect(mcpResult.matches).toHaveLength(1);
    expect(mcpResult.matches[0].id).toBe("search_docs");
  });

  test("matches MCP tool by description substring", async () => {
    await searchCmd(["page"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches.map((m) => m.id)).toContain("get_page");
  });

  test("matches OpenAPI operation by id", async () => {
    await searchCmd(["createPet"]);
    const apiResult = captured.results.find((r) => r.spec === "myapi");
    expect(apiResult.matches[0].id).toBe("createPet");
  });

  test("matches OpenAPI operation by path", async () => {
    await searchCmd(["petId"]);
    const apiResult = captured.results.find((r) => r.spec === "myapi");
    expect(apiResult.matches[0].id).toBe("getPet");
  });

  test("matches GraphQL operation by name", async () => {
    await searchCmd(["create"]);
    const gqlResult = captured.results.find((r) => r.spec === "mygql");
    expect(gqlResult.matches[0].id).toBe("createPost");
  });

  test("case insensitive", async () => {
    await searchCmd(["SEARCH"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches[0].id).toBe("search_docs");
  });

  test("joins words into one ranked query", async () => {
    await searchCmd(["create", "a", "pet"]);
    expect(captured.pattern).toBe("create a pet");
    expect(captured.results[0].spec).toBe("myapi");
    expect(captured.results[0].matches[0].id).toBe("createPet");
  });

  test("total counts all matches across specs", async () => {
    await searchCmd(["*e*"]);
    expect(captured.total).toBeGreaterThan(3);
  });
});

describe("search - glob patterns", () => {
  test("* glob matches multiple tools", async () => {
    await searchCmd(["*_docs"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches[0].id).toBe("search_docs");
  });

  test("* prefix glob", async () => {
    await searchCmd(["get*"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult.matches.map((m) => m.id)).toContain("get_page");
  });

  test("glob with many stars stays fast", async () => {
    const started = performance.now();
    await searchCmd([`${"*a".repeat(120)}b`]);
    expect(captured.total).toBe(0);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("no match returns empty results", async () => {
    await searchCmd(["zzz_nonexistent_zzz"]);
    expect(captured.total).toBe(0);
    expect(captured.results).toHaveLength(0);
  });
});

describe("search - --spec filter", () => {
  test("narrows to one spec", async () => {
    await searchCmd(["search", "--spec", "mymcp"]);
    expect(captured.results).toHaveLength(1);
    expect(captured.results[0].spec).toBe("mymcp");
  });

  test("skips disabled specs when searching all", async () => {
    registryEntries.mcp.mymcp.enabled = false; // disable mymcp
    await searchCmd(["search"]);
    const mcpResult = captured.results.find((r) => r.spec === "mymcp");
    expect(mcpResult).toBeUndefined();
  });

  test("rejects a disabled spec", async () => {
    registryEntries.mcp.mymcp.enabled = false;
    await expect(searchCmd(["search", "--spec", "mymcp"])).rejects.toThrow("disabled");
  });

  test("throws on missing pattern", async () => {
    await expect(searchCmd([])).rejects.toThrow("Usage");
  });

  test("--limit pages matches", async () => {
    await searchCmd(["*e*", "--limit", "2"]);
    expect(captured.total).toBeGreaterThan(2);
    expect(captured.showing).toBe(2);
    expect(captured.limit).toBe(2);
  });
});

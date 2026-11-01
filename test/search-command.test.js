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

function hits(spec) {
  return captured.results.filter((hit) => hit.spec === spec).map((hit) => hit.id);
}

describe("search - ranked text", () => {
  test("matches MCP tool by name", async () => {
    await searchCmd(["search"]);
    expect(hits("mymcp")).toEqual(["search_docs"]);
  });

  test("matches MCP tool by description", async () => {
    await searchCmd(["page"]);
    expect(hits("mymcp")).toContain("get_page");
  });

  test("matches OpenAPI operation by id", async () => {
    await searchCmd(["createPet"]);
    expect(captured.results[0]).toMatchObject({ rank: 1, spec: "myapi", id: "createPet" });
  });

  test("matches OpenAPI operation by path", async () => {
    await searchCmd(["petId"]);
    expect(hits("myapi")[0]).toBe("getPet");
  });

  test("matches GraphQL operation by name", async () => {
    await searchCmd(["create"]);
    expect(hits("mygql")).toEqual(["createPost"]);
  });

  test("every hit has the same help-style shape across spec types", async () => {
    await searchCmd(["*"]);
    expect(new Set(captured.results.map((hit) => hit.type))).toEqual(
      new Set(["mcp", "openapi", "graphql"])
    );
    for (const hit of captured.results)
      expect(Object.keys(hit)).toEqual(["rank", "spec", "type", "id", "description"]);
    expect(captured.results.find((hit) => hit.id === "getPet").description).toBe("Get one pet");
    expect(captured.results.find((hit) => hit.id === "me").description).toBe("Get current user");
  });

  test("summarises long descriptions to one short line", async () => {
    specCache.mymcp = {
      type: "mcp",
      tools: [{ name: "long_tool", description: `First line\n\n  ${"word ".repeat(100)}` }],
    };
    await searchCmd(["long_tool", "--spec", "mymcp"]);
    const { description } = captured.results[0];
    expect(description.startsWith("First line word")).toBe(true);
    expect(description).not.toContain("\n");
    expect(description.length).toBe(120);
    expect(description.endsWith("…")).toBe(true);
  });

  test("case insensitive", async () => {
    await searchCmd(["SEARCH"]);
    expect(captured.results[0].id).toBe("search_docs");
  });

  test("joins words into one ranked query", async () => {
    await searchCmd(["create", "a", "pet"]);
    expect(captured.query).toBe("create a pet");
    expect(captured.results[0]).toMatchObject({ rank: 1, spec: "myapi", id: "createPet" });
  });

  test("ranks across specs in one flat list", async () => {
    await searchCmd(["create"]);
    expect(captured.results.map((hit) => hit.rank)).toEqual(
      captured.results.map((_, index) => index + 1)
    );
    expect(new Set(captured.results.map((hit) => hit.spec))).toEqual(new Set(["myapi", "mygql"]));
  });

  test("total counts all matches across specs", async () => {
    await searchCmd(["*e*"]);
    expect(captured.total).toBeGreaterThan(3);
  });
});

describe("search - glob patterns", () => {
  test("* glob matches multiple tools", async () => {
    await searchCmd(["*_docs"]);
    expect(hits("mymcp")).toEqual(["search_docs"]);
  });

  test("* prefix glob", async () => {
    await searchCmd(["get*"]);
    expect(hits("mymcp")).toContain("get_page");
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
    await searchCmd(["*e*", "--spec", "mymcp"]);
    expect(new Set(captured.results.map((hit) => hit.spec))).toEqual(new Set(["mymcp"]));
  });

  test("narrows to a set of specs", async () => {
    await searchCmd(["create", "--spec", "myapi, mygql"]);
    expect(new Set(captured.results.map((hit) => hit.spec))).toEqual(new Set(["myapi", "mygql"]));
    await searchCmd(["*e*", "--spec", "mymcp,mygql"]);
    expect(hits("myapi")).toEqual([]);
  });

  test("reports specs that fail to load and keeps searching the rest", async () => {
    specCache.broken = null;
    registryEntries.openapi.broken = { type: "openapi", enabled: true, source: "missing.json" };
    await searchCmd(["create", "a", "pet"]);
    expect(captured.results[0].id).toBe("createPet");
    expect(captured.unavailable.map((item) => item.spec)).toEqual(["broken"]);
    await expect(searchCmd(["create", "--spec", "broken"])).rejects.toThrow();
  });

  test("rejects an unknown spec in the set", async () => {
    await expect(searchCmd(["create", "--spec", "myapi,nope"])).rejects.toThrow("nope");
  });

  test("skips disabled specs when searching all", async () => {
    registryEntries.mcp.mymcp.enabled = false;
    await searchCmd(["search"]);
    expect(hits("mymcp")).toEqual([]);
  });

  test("rejects a disabled spec", async () => {
    registryEntries.mcp.mymcp.enabled = false;
    await expect(searchCmd(["search", "--spec", "mymcp"])).rejects.toThrow("disabled");
  });

  test("throws on missing query", async () => {
    await expect(searchCmd([])).rejects.toThrow("Usage");
  });

  test("--limit and --offset page the ranked list", async () => {
    await searchCmd(["*e*"]);
    const all = captured.results.map((hit) => hit.id);
    await searchCmd(["*e*", "--limit", "2"]);
    expect(captured.total).toBe(all.length);
    expect(captured.showing).toBe(2);
    expect(captured.limit).toBe(2);
    expect(captured.results.map((hit) => hit.id)).toEqual(all.slice(0, 2));
    await searchCmd(["*e*", "--limit", "2", "--offset", "2"]);
    expect(captured.offset).toBe(2);
    expect(captured.results.map((hit) => hit.rank)).toEqual([3, 4]);
    expect(captured.results.map((hit) => hit.id)).toEqual(all.slice(2, 4));
  });
});

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => { captured = data; },
  err: (msg) => { captured = { error: msg }; },
}));

const fixturesDir = resolve(import.meta.dir, "fixtures");

function mockOpenAPI() {
  const raw = JSON.parse(readFileSync(resolve(fixturesDir, "openapi.json"), "utf-8"));
  return {
    type: "openapi",
    version: raw.openapi,
    title: raw.info.title,
    operations: Object.entries(raw.paths).flatMap(([path, methods]) =>
      Object.entries(methods).filter(([m]) => !m.startsWith("x-") && m !== "parameters").map(([method, op]) => ({
        id: op.operationId || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary || null,
        description: op.description || null,
        parameters: op.parameters || [],
        requestBody: op.requestBody || null,
        responses: op.responses || {},
        tags: op.tags || [],
        deprecated: op.deprecated || false,
      }))
    ),
    raw,
    components: raw.components,
  };
}

function mockGraphQL() {
  return JSON.parse(readFileSync(resolve(fixturesDir, "graphql-spec.json"), "utf-8"));
}

function mockMCP() {
  return {
    type: "mcp",
    transport: "streamable-http",
    url: "https://example.com/mcp",
    tools: [
      { name: "search_docs", description: "Search documentation", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      { name: "get_page", description: "Get a page by URL", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
    ],
  };
}

let currentSpec = mockOpenAPI();

mock.module("../src/resolve.js", () => ({
  resolveSpec: async (_flags) => ({ spec: currentSpec, entry: null }),
  resolveConfig: (_flags, _entry) => ({ baseUrl: null, headers: {}, auth: null }),
}));

const { listOperations } = await import("../src/commands/list.js");

describe("list - OpenAPI", () => {
  beforeEach(() => { captured = null; currentSpec = mockOpenAPI(); });

  test("lists all operations compact by default", async () => {
    await listOperations([]);
    expect(captured.total).toBe(3);
    expect(captured.operations[0]).toEqual({ id: "listPets", method: "GET", path: "/pets" });
    expect(captured.operations[0].summary).toBeUndefined();
  });

  test("--compact false shows full details", async () => {
    await listOperations(["--compact", "false"]);
    expect(captured.operations[0].summary).toBe("List all pets");
    expect(captured.operations[0].tags).toEqual(["pets"]);
  });

  test("--filter narrows results", async () => {
    await listOperations(["--filter", "create"]);
    expect(captured.total).toBe(1);
    expect(captured.operations[0].id).toBe("createPet");
  });

  test("--tag filters by tag", async () => {
    await listOperations(["--tag", "pets"]);
    expect(captured.total).toBe(3);
  });

  test("--limit paginates", async () => {
    await listOperations(["--limit", "1"]);
    expect(captured.showing).toBe(1);
    expect(captured.total).toBe(3);
  });

  test("--offset skips", async () => {
    await listOperations(["--limit", "1", "--offset", "2"]);
    expect(captured.showing).toBe(1);
    expect(captured.operations[0].id).toBe("getPet");
  });
});

describe("list - GraphQL", () => {
  beforeEach(() => { captured = null; currentSpec = mockGraphQL(); });

  test("lists compact with id and kind", async () => {
    await listOperations([]);
    expect(captured.total).toBe(4);
    expect(captured.operations[0]).toEqual({ id: "me", kind: "query" });
  });

  test("--tag filters by kind", async () => {
    await listOperations(["--tag", "mutation"]);
    expect(captured.total).toBe(1);
    expect(captured.operations[0].id).toBe("createPost");
  });

  test("subscription operations are listed", async () => {
    await listOperations(["--tag", "subscription"]);
    expect(captured.total).toBe(1);
    expect(captured.operations[0].id).toBe("postCreated");
  });
});

describe("list - MCP", () => {
  beforeEach(() => { captured = null; currentSpec = mockMCP(); });

  test("lists tools compact by default", async () => {
    await listOperations([]);
    expect(captured.type).toBe("mcp");
    expect(captured.total).toBe(2);
    expect(captured.operations[0]).toEqual({ id: "search_docs", description: "Search documentation" });
  });

  test("--compact false includes inputSchema", async () => {
    await listOperations(["--compact", "false"]);
    expect(captured.operations[0].inputSchema).toBeDefined();
    expect(captured.operations[0].inputSchema.properties.query).toBeDefined();
  });

  test("--filter narrows tools", async () => {
    await listOperations(["--filter", "page"]);
    expect(captured.total).toBe(1);
    expect(captured.operations[0].id).toBe("get_page");
  });
});

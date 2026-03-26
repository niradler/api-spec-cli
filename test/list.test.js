import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

// Capture output instead of printing
let captured;
mock.module("../src/output.js", () => ({
  out: (data) => { captured = data; },
  err: (msg) => { captured = { error: msg }; },
}));

// Mock store to use fixtures
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

mock.module("../src/store.js", () => {
  let spec = null;
  return {
    getSpec: () => spec,
    saveSpec: (s) => { spec = s; },
    getConfig: () => ({ baseUrl: null, headers: {}, auth: null }),
    setConfig: () => {},
    _setSpec: (s) => { spec = s; },
  };
});

const { listOperations } = await import("../src/commands/list.js");
const store = await import("../src/store.js");

describe("list - OpenAPI", () => {
  beforeEach(() => {
    captured = null;
    store._setSpec(mockOpenAPI());
  });

  test("lists all operations compact by default", async () => {
    await listOperations([]);
    expect(captured.total).toBe(3);
    expect(captured.operations[0]).toEqual({ id: "listPets", method: "GET", path: "/pets" });
    // Compact: no summary, no tags
    expect(captured.operations[0].summary).toBeUndefined();
    expect(captured.operations[0].tags).toBeUndefined();
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
  beforeEach(() => {
    captured = null;
    store._setSpec(mockGraphQL());
  });

  test("lists compact with id and kind", async () => {
    await listOperations([]);
    expect(captured.total).toBe(4);
    expect(captured.operations[0]).toEqual({ id: "me", kind: "query" });
    expect(captured.operations[0].args).toBeUndefined();
  });

  test("--tag filters by kind", async () => {
    await listOperations(["--tag", "mutation"]);
    expect(captured.total).toBe(1);
    expect(captured.operations[0].id).toBe("createPost");
  });

  test("--tag query excludes mutations and subscriptions", async () => {
    await listOperations(["--tag", "query"]);
    expect(captured.total).toBe(2);
    expect(captured.operations.every((o) => o.kind === "query")).toBe(true);
  });

  test("subscription operations are listed", async () => {
    await listOperations(["--tag", "subscription"]);
    expect(captured.total).toBe(1);
    expect(captured.operations[0].id).toBe("postCreated");
  });
});

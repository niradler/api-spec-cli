import { describe, test, expect, beforeEach, mock } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => {
    captured = data;
  },
  err: (msg) => {
    captured = { error: msg };
  },
}));

const fixturesDir = resolve(import.meta.dir, "fixtures");

function mockOpenAPI() {
  const raw = JSON.parse(readFileSync(resolve(fixturesDir, "openapi.json"), "utf-8"));
  return {
    type: "openapi",
    version: raw.openapi,
    title: raw.info.title,
    operations: Object.entries(raw.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([m]) => !m.startsWith("x-") && m !== "parameters")
        .map(([method, op]) => ({
          id: op.operationId,
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

let currentSpec = null;

mock.module("../src/resolve.js", () => ({
  resolveSpec: async (_flags) => ({ spec: currentSpec, entry: null }),
  resolveConfig: (_flags, _entry) => ({ baseUrl: null, headers: {}, auth: null }),
}));

const { showOperation } = await import("../src/commands/show.js");

describe("show - OpenAPI", () => {
  beforeEach(() => {
    captured = null;
    currentSpec = mockOpenAPI();
  });

  test("finds by operationId", async () => {
    await showOperation(["getPet"]);
    expect(captured.id).toBe("getPet");
    expect(captured.method).toBe("GET");
    expect(captured.path).toBe("/pets/{petId}");
  });

  test("finds by path", async () => {
    await showOperation(["/pets/{petId}"]);
    expect(captured.id).toBe("getPet");
  });

  test("finds by method + path", async () => {
    await showOperation(["POST /pets"]);
    expect(captured.id).toBe("createPet");
  });

  test("case insensitive matching", async () => {
    await showOperation(["GETPET"]);
    expect(captured.id).toBe("getPet");
  });

  test("resolves parameters with types", async () => {
    await showOperation(["getPet"]);
    expect(captured.parameters).toHaveLength(1);
    expect(captured.parameters[0].name).toBe("petId");
    expect(captured.parameters[0].in).toBe("path");
    expect(captured.parameters[0].required).toBe(true);
    expect(captured.parameters[0].type).toBe("integer");
  });

  test("resolves requestBody schema compactly", async () => {
    await showOperation(["createPet"]);
    expect(captured.requestBody).not.toBeNull();
    expect(captured.requestBody.schema.properties.name.type).toBe("string");
  });

  test("resolves response schemas", async () => {
    await showOperation(["getPet"]);
    expect(captured.responses["200"]).toBeDefined();
    expect(captured.responses["200"].schema.properties.name.type).toBe("string");
    // Nested $ref should show as name, not exploded
    expect(captured.responses["200"].schema.properties.category.$ref).toBe("Category");
  });

  test("error responses show description only", async () => {
    await showOperation(["getPet"]);
    expect(captured.responses["404"].description).toBe("Not found");
  });

  test("throws on unknown operation", async () => {
    await expect(showOperation(["nonexistent"])).rejects.toThrow("Operation not found");
  });
});

describe("show - GraphQL", () => {
  beforeEach(() => {
    captured = null;
    currentSpec = mockGraphQL();
  });

  test("shows operation with args", async () => {
    await showOperation(["posts"]);
    expect(captured.name).toBe("posts");
    expect(captured.kind).toBe("query");
    expect(captured.args).toHaveLength(2);
    expect(captured.args[0].name).toBe("first");
    expect(captured.args[0].type).toBe("Int!");
    expect(captured.args[0].required).toBe(true);
  });

  test("shows mutation", async () => {
    await showOperation(["createPost"]);
    expect(captured.kind).toBe("mutation");
    expect(captured.args[0].name).toBe("input");
    expect(captured.args[0].type).toBe("CreatePostInput!");
  });

  // BUG FIX: inputFields must be shown for INPUT_OBJECT related types
  test("related types include inputFields for INPUT_OBJECT", async () => {
    await showOperation(["createPost"]);
    const inputType = captured.relatedTypes.find((t) => t.name === "CreatePostInput");
    expect(inputType).toBeDefined();
    expect(inputType.kind).toBe("INPUT_OBJECT");
    expect(inputType.inputFields).toBeDefined();
    expect(inputType.inputFields.length).toBeGreaterThan(0);
    expect(inputType.inputFields[0].name).toBe("title");
    expect(inputType.inputFields[0].type).toBe("String!");
  });

  // BUG FIX: INPUT_OBJECT should NOT have empty/null fields
  test("INPUT_OBJECT related types do not have fields property", async () => {
    await showOperation(["createPost"]);
    const inputType = captured.relatedTypes.find((t) => t.name === "CreatePostInput");
    expect(inputType.fields).toBeUndefined();
  });

  test("OBJECT related types have fields not inputFields", async () => {
    await showOperation(["me"]);
    const userType = captured.relatedTypes.find((t) => t.name === "User");
    expect(userType.fields).toBeDefined();
    expect(userType.inputFields).toBeUndefined();
  });

  test("related types include enum values", async () => {
    // postCreated returns Post which doesn't reference PostStatus directly
    // but posts filter does reference PostFilter
    await showOperation(["posts"]);
    const filterType = captured.relatedTypes.find((t) => t.name === "PostFilter");
    expect(filterType).toBeDefined();
    expect(filterType.inputFields).toBeDefined();
  });

  test("case insensitive matching", async () => {
    await showOperation(["ME"]);
    expect(captured.name).toBe("me");
  });
});

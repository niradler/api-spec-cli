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
  return { type: "openapi", raw, components: raw.components };
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

const { typesCmd } = await import("../src/commands/types.js");
const store = await import("../src/store.js");

describe("types - OpenAPI", () => {
  beforeEach(() => {
    captured = null;
    store._setSpec(mockOpenAPI());
  });

  test("lists all schema names", async () => {
    await typesCmd([]);
    expect(captured.count).toBe(3);
    expect(captured.schemas).toContain("Pet");
    expect(captured.schemas).toContain("Category");
    expect(captured.schemas).toContain("PetInput");
  });

  test("inspects one schema compactly", async () => {
    await typesCmd(["Pet"]);
    expect(captured.name).toBe("Pet");
    expect(captured.type).toBe("object");
    expect(captured.required).toEqual(["name"]);
    expect(captured.properties.name.type).toBe("string");
    // Nested $ref shows as name, not exploded
    expect(captured.properties.category.$ref).toBe("Category");
  });

  test("case insensitive lookup", async () => {
    await typesCmd(["pet"]);
    expect(captured.name).toBe("Pet");
  });

  test("throws on unknown schema", async () => {
    await expect(typesCmd(["Nonexistent"])).rejects.toThrow("Schema not found");
  });
});

describe("types - GraphQL", () => {
  beforeEach(() => {
    captured = null;
    store._setSpec(mockGraphQL());
  });

  test("lists types grouped by kind", async () => {
    await typesCmd([]);
    expect(captured.count).toBeGreaterThan(0);
    expect(captured.types.OBJECT).toContain("User");
    expect(captured.types.OBJECT).toContain("Post");
    expect(captured.types.INPUT_OBJECT).toContain("PostFilter");
    expect(captured.types.ENUM).toContain("PostStatus");
  });

  test("inspects OBJECT type with fields", async () => {
    await typesCmd(["User"]);
    expect(captured.name).toBe("User");
    expect(captured.kind).toBe("OBJECT");
    expect(captured.fields).toBeDefined();
    expect(captured.fields.find((f) => f.name === "id").type).toBe("ID!");
  });

  test("inspects INPUT_OBJECT type with inputFields", async () => {
    await typesCmd(["PostFilter"]);
    expect(captured.name).toBe("PostFilter");
    expect(captured.kind).toBe("INPUT_OBJECT");
    expect(captured.inputFields).toBeDefined();
    expect(captured.inputFields.find((f) => f.name === "authorId")).toBeDefined();
  });

  test("inspects ENUM type with values", async () => {
    await typesCmd(["PostStatus"]);
    expect(captured.name).toBe("PostStatus");
    expect(captured.kind).toBe("ENUM");
    expect(captured.enumValues).toContain("DRAFT");
    expect(captured.enumValues).toContain("PUBLISHED");
  });

  test("case insensitive lookup", async () => {
    await typesCmd(["user"]);
    expect(captured.name).toBe("User");
  });
});

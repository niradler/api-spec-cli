import { describe, test, expect, mock } from "bun:test";

// Mock mcp-client before fetch.js is imported in this file
let mockTools = [];
mock.module("../src/mcp-client.js", () => ({
  createMcpClient: async () => ({
    listTools: async () => ({ tools: mockTools }),
    close: async () => {},
  }),
}));

const { matchGlob, matchFilter } = await import("../src/glob.js");

// Simulate the filtering logic from applyFilter (uses matchFilter — exact or glob)
function applyToolFilter(tools, allowedTools, disabledTools) {
  let result = [...tools];
  if (allowedTools?.length) {
    result = result.filter((t) => allowedTools.some((p) => matchFilter(p, t.name)));
  }
  if (disabledTools?.length) {
    result = result.filter((t) => !disabledTools.some((p) => matchFilter(p, t.name)));
  }
  return result;
}

const ALL_TOOLS = [
  { name: "read_file" },
  { name: "write_file" },
  { name: "delete_file" },
  { name: "list_dir" },
];

describe("matchGlob", () => {
  test("substring match (no glob chars)", () => {
    expect(matchGlob("search", "search_docs")).toBe(true);
    expect(matchGlob("SEARCH", "search_docs")).toBe(true); // case-insensitive
    expect(matchGlob("page", "get_page")).toBe(true);
    expect(matchGlob("xyz", "search_docs")).toBe(false);
  });

  test("* glob matches any sequence", () => {
    expect(matchGlob("search_*", "search_docs")).toBe(true);
    expect(matchGlob("search_*", "search_pages")).toBe(true);
    expect(matchGlob("search_*", "get_search")).toBe(false);
    expect(matchGlob("*_docs", "search_docs")).toBe(true);
    expect(matchGlob("get*", "get_page")).toBe(true);
    expect(matchGlob("get*", "search_docs")).toBe(false);
  });

  test("? glob matches single character", () => {
    expect(matchGlob("get_pag?", "get_page")).toBe(true);
    expect(matchGlob("get_pag?", "get_pages")).toBe(false);
  });

  test("* wildcard matches everything", () => {
    expect(matchGlob("*", "anything")).toBe(true);
  });
});

describe("matchFilter", () => {
  test("plain text = exact match (not substring)", () => {
    expect(matchFilter("me", "me")).toBe(true);
    expect(matchFilter("me", "topCommenters")).toBe(false); // would pass matchGlob
    expect(matchFilter("ME", "me")).toBe(true); // case-insensitive
    expect(matchFilter("getPet", "getPetById")).toBe(false);
  });

  test("* glob matches any sequence", () => {
    expect(matchFilter("get*", "getPetById")).toBe(true);
    expect(matchFilter("get*", "listPets")).toBe(false);
    expect(matchFilter("*post*", "createPost")).toBe(true); // explicit substring via glob
    expect(matchFilter("*post*", "deletePost")).toBe(true);
    expect(matchFilter("*post*", "getPet")).toBe(false);
  });

  test("? glob matches single character", () => {
    expect(matchFilter("getPe?", "getPet")).toBe(true);
    expect(matchFilter("getPe?", "getPets")).toBe(false);
  });

  test("* matches everything", () => {
    expect(matchFilter("*", "anything")).toBe(true);
  });
});

describe("MCP tool filtering logic", () => {
  test("no filter returns all tools", () => {
    expect(applyToolFilter(ALL_TOOLS, undefined, undefined)).toHaveLength(4);
  });

  test("allowedTools keeps only matching tools", () => {
    const result = applyToolFilter(ALL_TOOLS, ["read_*", "list_*"], undefined);
    expect(result.map((t) => t.name)).toEqual(["read_file", "list_dir"]);
  });

  test("disabledTools removes matching tools", () => {
    const result = applyToolFilter(ALL_TOOLS, undefined, ["delete_*"]);
    expect(result.map((t) => t.name)).not.toContain("delete_file");
    expect(result).toHaveLength(3);
  });

  test("disabledTools applied after allowedTools", () => {
    // allow *_file (read, write, delete), then disable delete_*
    const result = applyToolFilter(ALL_TOOLS, ["*_file"], ["delete_*"]);
    expect(result.map((t) => t.name)).toEqual(["read_file", "write_file"]);
  });

  test("allowedTools with exact name", () => {
    const result = applyToolFilter(ALL_TOOLS, ["read_file"], undefined);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
  });

  test("empty allowedTools passes all through", () => {
    const result = applyToolFilter(ALL_TOOLS, [], undefined);
    expect(result).toHaveLength(4);
  });
});

const ALL_OPS_OPENAPI = [
  { id: "listPets", method: "GET", path: "/pets" },
  { id: "getPet", method: "GET", path: "/pets/{petId}" },
  { id: "createPet", method: "POST", path: "/pets" },
  { id: "deletePet", method: "DELETE", path: "/pets/{petId}" },
];

function applyOpFilter(ops, allowed, disabled) {
  let result = [...ops];
  if (allowed?.length) result = result.filter((op) => allowed.some((p) => matchFilter(p, op.id)));
  if (disabled?.length)
    result = result.filter((op) => !disabled.some((p) => matchFilter(p, op.id)));
  return result;
}

describe("OpenAPI operation filtering", () => {
  test("no filter returns all operations", () => {
    expect(applyOpFilter(ALL_OPS_OPENAPI, undefined, undefined)).toHaveLength(4);
  });

  test("allowedTools keeps only matching operations by id", () => {
    const result = applyOpFilter(ALL_OPS_OPENAPI, ["get*", "list*"], undefined);
    expect(result.map((o) => o.id)).toEqual(["listPets", "getPet"]);
  });

  test("disabledTools removes matching operations by id", () => {
    const result = applyOpFilter(ALL_OPS_OPENAPI, undefined, ["delete*"]);
    expect(result.map((o) => o.id)).not.toContain("deletePet");
    expect(result).toHaveLength(3);
  });

  test("allowedTools then disabledTools", () => {
    const result = applyOpFilter(ALL_OPS_OPENAPI, ["*Pet"], ["deletePet"]);
    expect(result.map((o) => o.id)).toEqual(["getPet", "createPet"]);
  });
});

const ALL_OPS_GQL = [
  { name: "me", kind: "query" },
  { name: "publication", kind: "query" },
  { name: "createPost", kind: "mutation" },
  { name: "deletePost", kind: "mutation" },
];

function applyGqlFilter(ops, allowed, disabled) {
  let result = [...ops];
  if (allowed?.length) result = result.filter((op) => allowed.some((p) => matchFilter(p, op.name)));
  if (disabled?.length)
    result = result.filter((op) => !disabled.some((p) => matchFilter(p, op.name)));
  return result;
}

describe("GraphQL operation filtering", () => {
  test("no filter returns all operations", () => {
    expect(applyGqlFilter(ALL_OPS_GQL, undefined, undefined)).toHaveLength(4);
  });

  test("allowedTools keeps only matching operations by name", () => {
    const result = applyGqlFilter(ALL_OPS_GQL, ["me", "publication"], undefined);
    expect(result.map((o) => o.name)).toEqual(["me", "publication"]);
  });

  test("disabledTools removes matching operations by name", () => {
    const result = applyGqlFilter(ALL_OPS_GQL, undefined, ["delete*"]);
    expect(result.map((o) => o.name)).not.toContain("deletePost");
    expect(result).toHaveLength(3);
  });

  test("glob: allow only create* operations", () => {
    const result = applyGqlFilter(ALL_OPS_GQL, ["create*"], undefined);
    expect(result.map((o) => o.name)).toEqual(["createPost"]);
  });
});

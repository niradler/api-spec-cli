import { describe, test, expect, mock } from "bun:test";

// Mock mcp-client before fetch.js is imported in this file
let mockTools = [];
mock.module("../src/mcp-client.js", () => ({
  createMcpClient: async () => ({
    listTools: async () => ({ tools: mockTools }),
    close: async () => {},
  }),
}));

const { matchGlob } = await import("../src/glob.js");

// Simulate the filtering logic from loadMCPFromEntry (pure, no I/O)
function applyToolFilter(tools, allowedTools, disabledTools) {
  let result = [...tools];
  if (allowedTools?.length) {
    result = result.filter((t) => allowedTools.some((p) => matchGlob(p, t.name)));
  }
  if (disabledTools?.length) {
    result = result.filter((t) => !disabledTools.some((p) => matchGlob(p, t.name)));
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

import { describe, test, expect } from "bun:test";
import { createToolCatalog } from "../src/index.ts";
import { tokenize } from "../src/catalog.ts";

function op(id, method, path, summary) {
  return {
    id,
    method,
    path,
    summary,
    description: null,
    parameters: [],
    tags: [],
    deprecated: false,
  };
}

const petstore = {
  type: "openapi",
  servers: [{ url: "/api/v3" }],
  operations: [
    op("updatePet", "PUT", "/pet", "Update an existing pet by Id."),
    op("addPet", "POST", "/pet", "Add a new pet to the store."),
    op("findPetsByStatus", "GET", "/pet/findByStatus", "Finds Pets by status."),
    op("getPetById", "GET", "/pet/{petId}", "Find pet by ID."),
    op("deletePet", "DELETE", "/pet/{petId}", "Deletes a pet."),
    op("getOrderById", "GET", "/store/order/{orderId}", "Find purchase order by ID."),
    op("loginUser", "GET", "/user/login", "Logs user into the system."),
  ],
  components: {},
  raw: {},
};

const entry = {
  name: "petstore",
  _section: "openapi",
  type: "openapi",
  enabled: true,
  source: "x",
  config: {},
};

function catalog() {
  return createToolCatalog({ entries: () => [entry], load: async () => petstore });
}

async function search(query) {
  return (await catalog().search(query)).map((tool) => tool.id.replace("petstore.", ""));
}

describe("tokenize", () => {
  test("splits camelCase, acronyms, paths and punctuation", () => {
    expect(tokenize("getPetById")).toEqual(["get", "pet", "by", "id"]);
    expect(tokenize("HTTPRequest_log")).toEqual(["http", "request", "log"]);
    expect(tokenize("/pet/{petId}")).toEqual(["pet", "pet", "id"]);
    expect(tokenize("  ")).toEqual([]);
  });
});

describe("tool search ranking", () => {
  test("ranks the best id match first for a multi-word query", async () => {
    const results = await search("pet by id");
    expect(results[0]).toBe("getPetById");
    expect(results).toContain("updatePet");
  });

  test("matches compact ids case-insensitively", async () => {
    expect((await search("getpet"))[0]).toBe("getPetById");
    expect((await search("findPetsByStatus"))[0]).toBe("findPetsByStatus");
  });

  test("matches summary and path terms", async () => {
    expect(await search("purchase")).toEqual(["getOrderById"]);
    expect((await search("login"))[0]).toBe("loginUser");
  });

  test("prefers tools matching more query terms", async () => {
    const results = await search("delete pet");
    expect(results[0]).toBe("deletePet");
  });

  test("returns nothing for unmatched or empty queries", async () => {
    expect(await search("invoice")).toEqual([]);
    expect(await search("  ")).toEqual([]);
  });
});

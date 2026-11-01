import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { createToolCatalog } from "../src/index.ts";
import { createSearchIndex, searchTerms, tokenize } from "../src/search.ts";

function op(id, method, path, summary, tags = []) {
  return { id, method, path, summary, description: null, parameters: [], tags, deprecated: false };
}

function openapi(operations) {
  return { type: "openapi", servers: [], operations, components: {}, raw: {} };
}

const petstore = openapi([
  op("updatePet", "PUT", "/pet", "Update an existing pet by Id."),
  op("addPet", "POST", "/pet", "Add a new pet to the store."),
  op("findPetsByStatus", "GET", "/pet/findByStatus", "Finds Pets by status."),
  op("findPetsByTags", "GET", "/pet/findByTags", "Finds Pets by tags."),
  op("getPetById", "GET", "/pet/{petId}", "Find pet by ID."),
  op("deletePet", "DELETE", "/pet/{petId}", "Deletes a pet."),
  op("uploadFile", "POST", "/pet/{petId}/uploadImage", "Uploads an image."),
  op("getInventory", "GET", "/store/inventory", "Returns pet inventories by status."),
  op("placeOrder", "POST", "/store/order", "Place an order for a pet."),
  op("getOrderById", "GET", "/store/order/{orderId}", "Find purchase order by ID."),
  op("createUser", "POST", "/user", "Create user."),
  op("loginUser", "GET", "/user/login", "Logs user into the system."),
  op("logoutUser", "GET", "/user/logout", "Logs out current logged in user session."),
  op("getUserByName", "GET", "/user/{username}", "Get user by user name."),
]);

const github = openapi(
  JSON.parse(
    readFileSync(resolve(import.meta.dir, "fixtures", "github-operations.json"), "utf8")
  ).map((item) => op(item.id, item.method, item.path, item.summary, item.tags))
);

function entry(name, config = {}) {
  return { name, _section: "openapi", type: "openapi", enabled: true, source: "x", config };
}

function catalog(documents, entries = Object.keys(documents).map((name) => entry(name))) {
  return createToolCatalog({
    entries: () => entries,
    load: async (item) => documents[item.name],
  });
}

async function ids(tools, query, spec) {
  return (await tools.search(query, spec)).map((tool) => tool.id);
}

function hits(tools, spec, cases) {
  return Promise.all(
    cases.map(async ([query, want]) => {
      const found = (await ids(tools, query, spec)).slice(0, 3);
      return {
        query,
        top1: found[0] === `${spec}.${want}`,
        top3: found.includes(`${spec}.${want}`),
      };
    })
  );
}

describe("search terms", () => {
  test("tokenize splits camelCase, acronyms, paths and punctuation", () => {
    expect(tokenize("getPetById")).toEqual(["get", "pet", "by", "id"]);
    expect(tokenize("HTTPRequest_log")).toEqual(["http", "request", "log"]);
    expect(tokenize("/pet/{petId}")).toEqual(["pet", "pet", "id"]);
    expect(tokenize("  ")).toEqual([]);
  });

  test("drops stop words, stems plurals and maps API synonyms", () => {
    expect(searchTerms("remove a pet")).toEqual(["delete", "pet"]);
    expect(searchTerms("Sign in the user")).toEqual(["login", "user"]);
    expect(searchTerms("list pull requests")).toEqual(["list", "pull"]);
    expect(searchTerms("fetch repositories")).toEqual(["get", "repo"]);
    expect(searchTerms("categories access")).toEqual(["category", "access"]);
    expect(searchTerms("the of a")).toEqual([]);
  });

  test("index returns nothing for empty or unmatched queries", () => {
    const index = createSearchIndex([
      { id: "a", name: "get pet", path: "", summary: "", description: "", tags: "" },
    ]);
    expect(index.search("")).toEqual([]);
    expect(index.search("the")).toEqual([]);
    expect(index.search("invoice")).toEqual([]);
  });

  test("treats prototype property names as plain terms", () => {
    const index = createSearchIndex([
      {
        id: "build",
        name: "build object",
        path: "",
        summary: "Calls the constructor",
        description: "__proto__ toString valueOf",
        tags: "",
      },
    ]);
    expect(searchTerms("constructor __proto__")).toEqual(["constructor", "proto"]);
    expect(index.search("constructor")).toEqual(["build"]);
    expect(index.search("__proto__ hasOwnProperty")).toEqual(["build"]);
  });

  test("bounds work on hostile input", () => {
    const index = createSearchIndex([
      { id: "a", name: "get repo", path: "", summary: "", description: "", tags: "" },
    ]);
    const started = performance.now();
    expect(tokenize(`${"A".repeat(100_000)}!`)).toHaveLength(1);
    expect(index.search("repository".repeat(10_000))).toEqual([]);
    expect(index.search(`${"x".repeat(300)} repo`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("tool search ranking", () => {
  test("petstore queries rank the intended tool first", async () => {
    const results = await hits(catalog({ petstore }), "petstore", [
      ["pet by id", "getPetById"],
      ["getpet", "getPetById"],
      ["find pets by status", "findPetsByStatus"],
      ["remove a pet", "deletePet"],
      ["upload pet photo", "uploadFile"],
      ["store inventory", "getInventory"],
      ["sign in user", "loginUser"],
      ["update existing pet", "updatePet"],
      ["place an order", "placeOrder"],
      ["fetch user by username", "getUserByName"],
      ["purchase", "getOrderById"],
    ]);
    expect(results.filter((result) => !result.top1)).toEqual([]);
  });

  test("large catalog keeps natural-language recall", async () => {
    const results = await hits(catalog({ github }), "github", [
      ["list pull requests", "pulls/list"],
      ["merge a pull request", "pulls/merge"],
      ["delete branch protection", "repos/delete-branch-protection"],
      ["workflow runs for repo", "actions/list-workflow-runs-for-repo"],
      ["current authenticated user", "users/get-authenticated"],
      ["create a release", "repos/create-release"],
      ["search code", "search/code"],
      ["list commits", "repos/list-commits"],
      ["add labels to issue", "issues/add-labels"],
      ["star a repository", "activity/star-repo-for-authenticated-user"],
      ["fork repo", "repos/create-fork"],
      ["list pr review comments", "pulls/list-review-comments"],
      ["remove a collaborator", "repos/remove-collaborator"],
    ]);
    expect(results.filter((result) => !result.top3)).toEqual([]);
    expect(results.filter((result) => result.top1).length).toBeGreaterThanOrEqual(7);
  });

  test("searches across specs and within one spec", async () => {
    const tools = catalog({ petstore, github });
    const all = await ids(tools, "delete pet");
    expect(all[0]).toBe("petstore.deletePet");
    expect((await ids(tools, "merge pull request", "github"))[0]).toBe("github.pulls/merge");
    expect((await ids(tools, "merge pull request", "petstore")).length).toBe(0);
    expect((await ids(tools, "delete", ["petstore", "github"])).length).toBeGreaterThan(1);
    expect((await ids(tools, "merge pull request", ["github"]))[0]).toBe("github.pulls/merge");
    await expect(tools.search("pet", ["petstore", "missing"])).rejects.toThrow("Unavailable spec");
  });

  test("glob queries filter ids, paths and summaries instead of ranking", async () => {
    const tools = catalog({ petstore });
    expect(await ids(tools, "get*ById")).toEqual(["petstore.getPetById", "petstore.getOrderById"]);
    expect(await ids(tools, "/user/log*")).toEqual(["petstore.loginUser", "petstore.logoutUser"]);
    expect(await ids(tools, `${"*a".repeat(120)}b`)).toEqual([]);
  });

  test("reflects tool filter changes without a new catalog", async () => {
    const entries = [entry("petstore")];
    const tools = catalog({ petstore }, entries);
    expect((await ids(tools, "delete pet"))[0]).toBe("petstore.deletePet");
    entries[0] = entry("petstore", { disabledTools: ["deletePet"] });
    expect(await ids(tools, "delete pet")).not.toContain("petstore.deletePet");
  });
});

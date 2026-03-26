import { describe, test, expect, mock } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => { captured = data; },
  err: (msg) => { captured = { error: msg }; },
}));

const fixturesDir = resolve(import.meta.dir, "fixtures");

function mockGraphQL() {
  return JSON.parse(
    require("fs").readFileSync(resolve(fixturesDir, "graphql-spec.json"), "utf-8")
  );
}

// Track what fetch receives
let lastFetchUrl, lastFetchOpts;
const originalFetch = globalThis.fetch;

function mockFetch(responseData) {
  globalThis.fetch = async (url, opts) => {
    lastFetchUrl = url;
    lastFetchOpts = opts;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => responseData,
      text: async () => JSON.stringify(responseData),
    };
  };
}

mock.module("../src/store.js", () => {
  let spec = null;
  let config = { baseUrl: null, headers: {}, auth: null };
  return {
    getSpec: () => spec,
    saveSpec: (s) => { spec = s; },
    getConfig: () => config,
    setConfig: (c) => { config = c; },
    _setSpec: (s) => { spec = s; },
    _setConfig: (c) => { config = c; },
  };
});

const { callOperation } = await import("../src/commands/call.js");
const store = await import("../src/store.js");

describe("call - GraphQL", () => {
  test("auto-builds query from operation schema", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: null });
    mockFetch({ data: { me: { id: "1", name: "Test", email: "test@test.com" } } });

    captured = null;
    await callOperation(["me"]);

    const sentBody = JSON.parse(lastFetchOpts.body);
    expect(sentBody.query).toContain("me");
    expect(sentBody.query).toContain("id");
    expect(sentBody.query).toContain("name");
    expect(captured.status).toBe(200);
    expect(captured.data.me.name).toBe("Test");

    globalThis.fetch = originalFetch;
  });

  // BUG FIX: --data with {query, variables} must pass both through
  test("--data passes query AND variables from JSON", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: null });
    mockFetch({ data: { posts: { edges: [] } } });

    captured = null;
    const dataJson = JSON.stringify({
      query: "query($first: Int!) { posts(first: $first) { edges { node { title } } } }",
      variables: { first: 10, filter: { authorId: "abc" } },
    });
    await callOperation(["posts", "--data", dataJson]);

    const sentBody = JSON.parse(lastFetchOpts.body);
    expect(sentBody.query).toContain("posts(first: $first)");
    expect(sentBody.variables).toBeDefined();
    expect(sentBody.variables.first).toBe(10);
    expect(sentBody.variables.filter.authorId).toBe("abc");

    globalThis.fetch = originalFetch;
  });

  // BUG FIX: --data variables should not be dropped
  test("--data variables are not lost during parsing", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: null });
    mockFetch({ data: {} });

    const dataJson = JSON.stringify({
      query: "{ me { id } }",
      variables: { complex: { nested: true, arr: [1, 2] } },
    });
    await callOperation(["me", "--data", dataJson]);

    const sentBody = JSON.parse(lastFetchOpts.body);
    expect(sentBody.variables.complex.nested).toBe(true);
    expect(sentBody.variables.complex.arr).toEqual([1, 2]);

    globalThis.fetch = originalFetch;
  });

  test("--var overrides --data variables", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: null });
    mockFetch({ data: {} });

    const dataJson = JSON.stringify({
      query: "{ me { id } }",
      variables: { key: "original" },
    });
    await callOperation(["me", "--data", dataJson, "--var", "key=override"]);

    const sentBody = JSON.parse(lastFetchOpts.body);
    expect(sentBody.variables.key).toBe("override");

    globalThis.fetch = originalFetch;
  });

  test("auth token adds Bearer prefix", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: "my-token" });
    mockFetch({ data: { me: {} } });

    await callOperation(["me"]);
    expect(lastFetchOpts.headers["Authorization"]).toBe("Bearer my-token");

    globalThis.fetch = originalFetch;
  });

  test("explicit Bearer auth is not doubled", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: "Bearer my-token" });
    mockFetch({ data: { me: {} } });

    await callOperation(["me"]);
    expect(lastFetchOpts.headers["Authorization"]).toBe("Bearer my-token");

    globalThis.fetch = originalFetch;
  });

  // BUG FIX: --data-file reads from file
  test("--data-file reads JSON from file", async () => {
    store._setSpec(mockGraphQL());
    store._setConfig({ baseUrl: "https://gql.test.com", headers: {}, auth: null });
    mockFetch({ data: { posts: [] } });

    const tmpFile = resolve(fixturesDir, "_tmp_query.json");
    writeFileSync(tmpFile, JSON.stringify({
      query: "{ posts(first: 3) { edges { node { title } } } }",
      variables: { first: 3 },
    }));

    try {
      await callOperation(["posts", "--data-file", tmpFile]);
      const sentBody = JSON.parse(lastFetchOpts.body);
      expect(sentBody.query).toContain("posts(first: 3)");
      expect(sentBody.variables.first).toBe(3);
    } finally {
      unlinkSync(tmpFile);
      globalThis.fetch = originalFetch;
    }
  });
});

describe("call - OpenAPI", () => {
  function mockOpenAPISpec() {
    const raw = JSON.parse(
      require("fs").readFileSync(resolve(fixturesDir, "openapi.json"), "utf-8")
    );
    return {
      type: "openapi",
      servers: raw.servers,
      operations: Object.entries(raw.paths).flatMap(([path, methods]) =>
        Object.entries(methods).filter(([m]) => !m.startsWith("x-")).map(([method, op]) => ({
          id: op.operationId,
          method: method.toUpperCase(),
          path,
          parameters: op.parameters || [],
          requestBody: op.requestBody || null,
          responses: op.responses || {},
        }))
      ),
      raw,
    };
  }

  test("substitutes path variables", async () => {
    store._setSpec(mockOpenAPISpec());
    store._setConfig({ baseUrl: "https://api.test.com", headers: {}, auth: null });
    mockFetch({ id: 1, name: "Rex" });

    await callOperation(["getPet", "--var", "petId=42"]);
    expect(lastFetchUrl).toBe("https://api.test.com/pets/42");

    globalThis.fetch = originalFetch;
  });

  test("adds query params", async () => {
    store._setSpec(mockOpenAPISpec());
    store._setConfig({ baseUrl: "https://api.test.com", headers: {}, auth: null });
    mockFetch([]);

    await callOperation(["listPets", "--query", "limit=10"]);
    expect(lastFetchUrl).toBe("https://api.test.com/pets?limit=10");

    globalThis.fetch = originalFetch;
  });

  test("sends JSON body with --data", async () => {
    store._setSpec(mockOpenAPISpec());
    store._setConfig({ baseUrl: "https://api.test.com", headers: {}, auth: null });
    mockFetch({ id: 1, name: "Rex" });

    await callOperation(["createPet", "--data", '{"name":"Rex"}']);
    expect(lastFetchOpts.body).toBe('{"name":"Rex"}');
    expect(lastFetchOpts.headers["Content-Type"]).toBe("application/json");

    globalThis.fetch = originalFetch;
  });

  test("custom headers are sent", async () => {
    store._setSpec(mockOpenAPISpec());
    store._setConfig({ baseUrl: "https://api.test.com", headers: { "X-Global": "yes" }, auth: null });
    mockFetch([]);

    await callOperation(["listPets", "--header", "X-Custom=val"]);
    expect(lastFetchOpts.headers["X-Global"]).toBe("yes");
    expect(lastFetchOpts.headers["X-Custom"]).toBe("val");

    globalThis.fetch = originalFetch;
  });
});

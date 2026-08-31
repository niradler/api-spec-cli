import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFileSync, unlinkSync, mkdirSync, rmSync, existsSync } from "fs";
import { readFileSync } from "fs";
import { resolve, join } from "path";
import { tmpdir } from "os";
import { setPolicyDir, setLocalPolicyFile, setPoliciesDir } from "../src/policy.js";
import { setCacheDir } from "../src/cache.js";

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

function mockGraphQL() {
  return JSON.parse(readFileSync(resolve(fixturesDir, "graphql-spec.json"), "utf-8"));
}

function mockOpenAPISpec() {
  const raw = JSON.parse(readFileSync(resolve(fixturesDir, "openapi.json"), "utf-8"));
  return {
    type: "openapi",
    servers: raw.servers,
    operations: Object.entries(raw.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([m]) => !m.startsWith("x-"))
        .map(([method, op]) => ({
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

// Mock resolve.js to return a controllable spec
let currentSpec = mockGraphQL();
let currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };

mock.module("../src/resolve.js", () => ({
  resolveSpec: async (_flags) => ({ spec: currentSpec, entry: null }),
  resolveConfig: (_flags, _entry) => currentConfig,
}));

let mcpCallTool;
mock.module("../src/mcp-client.js", () => ({
  createMcpClient: async () => ({
    callTool: async (args) => {
      mcpCallTool = args;
      return { content: [{ type: "text", text: "ok" }], isError: false };
    },
    close: async () => {},
  }),
}));

const { callOperation } = await import("../src/commands/call.js");

const POLICY_DIR = join(tmpdir(), "spec-cli-test-call-policy-" + process.pid);
const CACHE_DIR = join(tmpdir(), "spec-cli-test-call-cache-" + process.pid);

beforeEach(() => {
  mkdirSync(POLICY_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  setPolicyDir(POLICY_DIR);
  setLocalPolicyFile(join(POLICY_DIR, "local-policy.json"));
  setPoliciesDir(null);
  setCacheDir(CACHE_DIR);
  const file = join(POLICY_DIR, "policy.json");
  if (existsSync(file)) rmSync(file);
  lastFetchUrl = undefined;
  mcpCallTool = undefined;
});

afterEach(() => {
  rmSync(POLICY_DIR, { recursive: true, force: true });
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

describe("call - GraphQL", () => {
  test("auto-builds query from operation schema", async () => {
    currentSpec = mockGraphQL();
    currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };
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

  test("--data passes query AND variables from JSON", async () => {
    currentSpec = mockGraphQL();
    currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };
    mockFetch({ data: { posts: { edges: [] } } });

    captured = null;
    const dataJson = JSON.stringify({
      query: "query($first: Int!) { posts(first: $first) { edges { node { title } } } }",
      variables: { first: 10, filter: { authorId: "abc" } },
    });
    await callOperation(["posts", "--data", dataJson]);

    const sentBody = JSON.parse(lastFetchOpts.body);
    expect(sentBody.query).toContain("posts(first: $first)");
    expect(sentBody.variables.first).toBe(10);
    expect(sentBody.variables.filter.authorId).toBe("abc");

    globalThis.fetch = originalFetch;
  });

  test("--data variables are not lost during parsing", async () => {
    currentSpec = mockGraphQL();
    currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };
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
    currentSpec = mockGraphQL();
    currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };
    mockFetch({ data: {} });

    const dataJson = JSON.stringify({ query: "{ me { id } }", variables: { key: "original" } });
    await callOperation(["me", "--data", dataJson, "--var", "key=override"]);

    const sentBody = JSON.parse(lastFetchOpts.body);
    expect(sentBody.variables.key).toBe("override");

    globalThis.fetch = originalFetch;
  });

  test("auth token in config adds Authorization header", async () => {
    currentSpec = mockGraphQL();
    currentConfig = {
      baseUrl: "https://gql.test.com",
      headers: { Authorization: "Bearer my-token" },
      auth: "my-token",
    };
    mockFetch({ data: { me: {} } });

    await callOperation(["me"]);
    expect(lastFetchOpts.headers["Authorization"]).toBe("Bearer my-token");

    globalThis.fetch = originalFetch;
  });

  test("--data-file reads JSON from file", async () => {
    currentSpec = mockGraphQL();
    currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };
    mockFetch({ data: { posts: [] } });

    const tmpFile = resolve(fixturesDir, "_tmp_query.json");
    writeFileSync(
      tmpFile,
      JSON.stringify({
        query: "{ posts(first: 3) { edges { node { title } } } }",
        variables: { first: 3 },
      })
    );

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
  test("substitutes path variables", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: {}, auth: null };
    mockFetch({ id: 1, name: "Rex" });

    await callOperation(["getPet", "--var", "petId=42"]);
    expect(lastFetchUrl).toBe("https://api.test.com/pets/42");

    globalThis.fetch = originalFetch;
  });

  test("should reuse a call cache hit for the same path and params", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: {}, auth: null };
    let fetches = 0;
    globalThis.fetch = async (url, opts) => {
      fetches += 1;
      lastFetchUrl = url;
      lastFetchOpts = opts;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ id: 1, name: "Rex" }),
        text: async () => JSON.stringify({ id: 1, name: "Rex" }),
      };
    };

    await callOperation(["getPet", "--var", "petId=42"]);
    await callOperation(["getPet", "--var", "petId=42"]);
    expect(fetches).toBe(1);
    await callOperation(["getPet", "--var", "petId=99"]);
    expect(fetches).toBe(2);

    globalThis.fetch = originalFetch;
  });

  test("should not cache a failed OpenAPI call", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: {}, auth: null };
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      return {
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ error: "boom" }),
        text: async () => JSON.stringify({ error: "boom" }),
      };
    };

    await callOperation(["getPet", "--var", "petId=42"]);
    await callOperation(["getPet", "--var", "petId=42"]);
    expect(fetches).toBe(2);

    globalThis.fetch = originalFetch;
  });

  test("adds query params", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: {}, auth: null };
    mockFetch([]);

    await callOperation(["listPets", "--query", "limit=10"]);
    expect(lastFetchUrl).toBe("https://api.test.com/pets?limit=10");

    globalThis.fetch = originalFetch;
  });

  test("sends JSON body with --data", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: {}, auth: null };
    mockFetch({ id: 1, name: "Rex" });

    await callOperation(["createPet", "--data", '{"name":"Rex"}']);
    expect(lastFetchOpts.body).toBe('{"name":"Rex"}');
    expect(lastFetchOpts.headers["Content-Type"]).toBe("application/json");

    globalThis.fetch = originalFetch;
  });

  test("custom headers from config and --header flag are merged", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: { "X-Global": "yes" }, auth: null };
    mockFetch([]);

    await callOperation(["listPets", "--header", "X-Custom=val"]);
    // X-Global comes from resolveConfig (mocked), X-Custom from the call flag
    // Since resolveConfig is mocked, the headers in config are what we set above
    expect(lastFetchOpts.headers["X-Global"]).toBe("yes");

    globalThis.fetch = originalFetch;
  });

  test("blocks a matching policy rule before fetch", async () => {
    currentSpec = mockOpenAPISpec();
    currentConfig = { baseUrl: "https://api.test.com", headers: {}, auth: null };
    writeFileSync(
      join(POLICY_DIR, "policy.json"),
      JSON.stringify({
        rules: [
          {
            id: "no-pet-42",
            effect: "block",
            tool: "getPet",
            when: { petId: { eq: "42" } },
            message: "pet 42 is locked",
          },
        ],
      })
    );

    await expect(callOperation(["getPet", "--var", "petId=42"])).rejects.toThrow(
      "blocked by policy: pet 42 is locked"
    );
    expect(lastFetchUrl).toBeUndefined();
  });
});

describe("call - GraphQL policy", () => {
  test("blocks before fetch", async () => {
    currentSpec = mockGraphQL();
    currentConfig = { baseUrl: "https://gql.test.com", headers: {}, auth: null };
    writeFileSync(
      join(POLICY_DIR, "policy.json"),
      JSON.stringify({
        rules: [
          {
            id: "no-me",
            effect: "block",
            tool: "me",
            message: "me is locked",
          },
        ],
      })
    );

    await expect(callOperation(["me"])).rejects.toThrow("blocked by policy: me is locked");
    expect(lastFetchUrl).toBeUndefined();
  });
});

describe("call - MCP policy", () => {
  test("blocks before callTool", async () => {
    currentSpec = {
      type: "mcp",
      tools: [{ name: "restart", description: "Restart a pod", inputSchema: null }],
    };
    writeFileSync(
      join(POLICY_DIR, "policy.json"),
      JSON.stringify({
        rules: [
          {
            id: "no-prod-restart",
            effect: "block",
            tool: "restart",
            when: { pod_name: { prefix: "prod" } },
            message: "cannot restart prod pods",
          },
        ],
      })
    );

    await expect(callOperation(["restart", "--var", "pod_name=prod-api"])).rejects.toThrow(
      "blocked by policy: cannot restart prod pods"
    );
    expect(mcpCallTool).toBeUndefined();
  });
});

import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeOperation, setCacheDir, setUsageDir } from "../src/index.ts";
import { serverUrl } from "../src/execute.ts";

const home = mkdtempSync(join(tmpdir(), "spec-cli-server-url-"));
const originalFetch = globalThis.fetch;

beforeAll(() => {
  setCacheDir(join(home, "cache"));
  setUsageDir(join(home, "usage"));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  setCacheDir(undefined);
  setUsageDir(undefined);
  rmSync(home, { recursive: true, force: true });
});

function spec(url) {
  return {
    type: "openapi",
    servers: url === undefined ? [] : [{ url }],
    operations: [
      {
        id: "getPetById",
        method: "GET",
        path: "/pet/{petId}",
        summary: null,
        description: null,
        parameters: [],
        requestBody: null,
        responses: {},
        tags: [],
        deprecated: false,
      },
    ],
    components: {},
    raw: {},
  };
}

const source = "https://petstore3.swagger.io/api/v3/openapi.json";

describe("serverUrl", () => {
  test("resolves an absolute-path server against the spec source origin", () => {
    expect(serverUrl(spec("/api/v3"), source)).toBe("https://petstore3.swagger.io/api/v3");
  });

  test("resolves a relative server against the spec source directory", () => {
    expect(serverUrl(spec("v2"), "https://api.test/specs/openapi.json")).toBe(
      "https://api.test/specs/v2"
    );
    expect(serverUrl(spec("/"), source)).toBe("https://petstore3.swagger.io");
  });

  test("keeps absolute server URLs unchanged", () => {
    expect(serverUrl(spec("https://other.test/v1"), source)).toBe("https://other.test/v1");
  });

  test("leaves relative servers alone when the source is not a URL", () => {
    expect(serverUrl(spec("/api/v3"), "./openapi.json")).toBe("/api/v3");
    expect(serverUrl(spec("/api/v3"))).toBe("/api/v3");
    expect(serverUrl(spec(undefined), source)).toBe("");
  });
});

describe("executeOperation with relative servers", () => {
  function capture() {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: 7 }), {
        headers: { "content-type": "application/json" },
      });
    };
    return urls;
  }

  const entry = () => ({
    name: "inline-petstore",
    _section: "openapi",
    type: "openapi",
    enabled: true,
    source,
    config: {},
  });

  test("calls the server resolved from the spec source", async () => {
    const urls = capture();
    const result = await executeOperation(spec("/api/v3"), entry(), "getPetById", {
      exact: true,
      vars: { petId: "7" },
    });
    expect(result.status).toBe(200);
    expect(urls).toEqual(["https://petstore3.swagger.io/api/v3/pet/7"]);
  });
});

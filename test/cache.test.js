import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = join(tmpdir(), `spec-cli-cache-test-${process.pid}`);

const {
  setCacheDir,
  sweepCache,
  getMetaCache,
  setMetaCache,
  getCallCache,
  setCallCache,
  callCacheKey,
} = await import("../src/cache.js");

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  setCacheDir(dir);
  delete process.env.SPEC_NO_CACHE;
  delete process.env.SPEC_META_CACHE_MS;
  delete process.env.SPEC_CALL_CACHE_MS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SPEC_NO_CACHE;
  delete process.env.SPEC_META_CACHE_MS;
  delete process.env.SPEC_CALL_CACHE_MS;
});

describe("file cache", () => {
  test("should return meta written within ttl", () => {
    const spec = { type: "mcp", tools: [{ name: "search_agno" }] };
    setMetaCache("agno", spec);
    expect(getMetaCache("agno")).toEqual(spec);
    expect(existsSync(join(dir, "meta-agno.json"))).toBe(true);
  });

  test("should miss expired meta and delete the file on sweep", () => {
    process.env.SPEC_META_CACHE_MS = "1";
    setMetaCache("agno", { type: "mcp", tools: [] });
    const file = join(dir, "meta-agno.json");
    const rec = JSON.parse(readFileSync(file, "utf-8"));
    rec.cachedAt = Date.now() - 1000;
    writeFileSync(file, JSON.stringify(rec));
    expect(getMetaCache("agno")).toBe(null);
    sweepCache();
    expect(existsSync(file)).toBe(false);
  });

  test("should return call result within ttl", () => {
    const payload = {
      tool: "search_agno",
      isError: false,
      content: [{ type: "text", text: "hi" }],
    };
    const key = callCacheKey({ spec: "agno", tool: "search_agno", args: { query: "a" } });
    setCallCache(key, payload, { spec: "agno" });
    expect(getCallCache(key)).toEqual(payload);
  });

  test("should miss expired call results after sweep", () => {
    process.env.SPEC_CALL_CACHE_MS = "1";
    const key = callCacheKey({ spec: "agno", tool: "x", args: {} });
    setCallCache(key, { ok: true }, { spec: "agno" });
    const files = readdirSync(dir).filter((n) => n.startsWith("call-"));
    expect(files.length).toBe(1);
    const file = join(dir, files[0]);
    const rec = JSON.parse(readFileSync(file, "utf-8"));
    rec.cachedAt = Date.now() - 5000;
    writeFileSync(file, JSON.stringify(rec));
    sweepCache();
    expect(getCallCache(key)).toBe(null);
    expect(existsSync(file)).toBe(false);
  });

  test("should skip cache when SPEC_NO_CACHE is set", () => {
    setMetaCache("agno", { type: "mcp", tools: [] });
    process.env.SPEC_NO_CACHE = "1";
    expect(getMetaCache("agno")).toBe(null);
  });

  test("should produce a stable call cache key from path and all params", () => {
    const a = callCacheKey({
      spec: "petstore",
      path: "/pet/1",
      method: "GET",
      query: { status: "available" },
      vars: { petId: "1" },
    });
    const b = callCacheKey({
      spec: "petstore",
      path: "/pet/1",
      method: "GET",
      vars: { petId: "1" },
      query: { status: "available" },
    });
    const otherPath = callCacheKey({
      spec: "petstore",
      path: "/pet/2",
      method: "GET",
      query: { status: "available" },
      vars: { petId: "2" },
    });
    const otherQuery = callCacheKey({
      spec: "petstore",
      path: "/pet/1",
      method: "GET",
      query: { status: "sold" },
      vars: { petId: "1" },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(otherPath);
    expect(a).not.toBe(otherQuery);
  });

  test("should keep fresh files when sweeping expired ones", () => {
    setMetaCache("fresh", { type: "mcp", tools: [{ name: "a" }] });
    writeFileSync(
      join(dir, "call-dead.json"),
      JSON.stringify({ kind: "call", cachedAt: Date.now() - 120000, ttl: 60000, data: { x: 1 } })
    );
    sweepCache();
    expect(getMetaCache("fresh")).toEqual({ type: "mcp", tools: [{ name: "a" }] });
    expect(existsSync(join(dir, "call-dead.json"))).toBe(false);
  });
});

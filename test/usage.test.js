import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { recordUsage, getUsage, topOperations, allUsage, setUsageDir } from "../src/usage.js";

const TEST_DIR = join(tmpdir(), "spec-cli-test-usage-" + process.pid);

describe("usage store", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setUsageDir(TEST_DIR);
    delete process.env.SPEC_NO_USAGE;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    delete process.env.SPEC_NO_USAGE;
  });

  test("recordUsage increments count and persists", () => {
    recordUsage("myapi", "getUser");
    recordUsage("myapi", "getUser");
    recordUsage("myapi", "listUsers");

    const usage = getUsage("myapi");
    expect(usage["getUser"].count).toBe(2);
    expect(usage["listUsers"].count).toBe(1);
    expect(typeof usage["getUser"].lastUsed).toBe("string");
  });

  test("recordUsage persists across separate loadStore calls", () => {
    recordUsage("myapi", "op1");
    // Re-read via allUsage to confirm on-disk persistence
    const store = allUsage();
    expect(store["myapi"]["op1"].count).toBe(1);
  });

  test("SPEC_NO_USAGE opt-out is a no-op", () => {
    process.env.SPEC_NO_USAGE = "1";
    recordUsage("myapi", "getUser");
    expect(getUsage("myapi")).toEqual({});
  });

  test("recordUsage never throws on bad dir", () => {
    setUsageDir("/no/such/path/that/cannot/exist/spec-cli-test-" + Date.now());
    expect(() => recordUsage("myapi", "getUser")).not.toThrow();
    setUsageDir(TEST_DIR);
  });

  test("inline spec (no specName) is skipped", () => {
    recordUsage("", "getUser");
    recordUsage(null, "getUser");
    recordUsage(undefined, "getUser");
    expect(allUsage()).toEqual({});
  });

  test("topOperations returns sorted by count desc", () => {
    recordUsage("myapi", "op1");
    recordUsage("myapi", "op2");
    recordUsage("myapi", "op2");
    recordUsage("myapi", "op3");
    recordUsage("myapi", "op3");
    recordUsage("myapi", "op3");

    const top = topOperations("myapi", 2);
    expect(top.length).toBe(2);
    expect(top[0].id).toBe("op3");
    expect(top[0].count).toBe(3);
    expect(top[1].id).toBe("op2");
    expect(top[1].count).toBe(2);
  });

  test("topOperations limits to n results", () => {
    recordUsage("myapi", "a");
    recordUsage("myapi", "b");
    recordUsage("myapi", "c");
    const top = topOperations("myapi", 2);
    expect(top.length).toBe(2);
  });

  test("topOperations returns [] for unknown spec", () => {
    expect(topOperations("ghost", 5)).toEqual([]);
  });

  test("getUsage returns {} for unknown spec", () => {
    expect(getUsage("unknown")).toEqual({});
  });
});

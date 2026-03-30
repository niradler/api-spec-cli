import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadTokenFile, saveTokenFile, clearTokenFile, setTokenDir } from "../src/oauth/tokens.js";

const TEST_DIR = join(tmpdir(), "spec-cli-test-tokens-" + process.pid);

describe("token file helpers", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setTokenDir(TEST_DIR);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("loadTokenFile returns {} when file does not exist", () => {
    expect(loadTokenFile("nonexistent")).toEqual({});
  });

  test("saveTokenFile + loadTokenFile round-trips data", () => {
    const data = {
      tokens: { access_token: "abc", expires_in: 3600 },
      clientInfo: { client_id: "x" },
    };
    saveTokenFile("myspec", data);
    expect(loadTokenFile("myspec")).toEqual(data);
  });

  test("clearTokenFile deletes the file", () => {
    saveTokenFile("myspec", { tokens: { access_token: "abc" } });
    clearTokenFile("myspec");
    expect(loadTokenFile("myspec")).toEqual({});
  });

  test("clearTokenFile is safe when file does not exist", () => {
    expect(() => clearTokenFile("ghost")).not.toThrow();
  });

  test("saveTokenFile merges with existing data", () => {
    saveTokenFile("myspec", { tokens: { access_token: "old" } });
    saveTokenFile("myspec", { clientInfo: { client_id: "x" } });
    const data = loadTokenFile("myspec");
    expect(data.tokens.access_token).toBe("old");
    expect(data.clientInfo.client_id).toBe("x");
  });
});

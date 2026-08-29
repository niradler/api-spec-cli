import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadTokenFile,
  saveTokenFile,
  clearTokenFile,
  setTokenDir,
  getClientSecret,
} from "../src/oauth/tokens.js";

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

  test("getClientSecret expands ${VAR} from the environment", () => {
    process.env.MY_CLIENT_SECRET = "expanded-secret";
    saveTokenFile("myspec", { clientSecret: "${MY_CLIENT_SECRET}" });
    expect(getClientSecret("myspec")).toBe("expanded-secret");
    delete process.env.MY_CLIENT_SECRET;
  });

  test("getClientSecret returns a literal secret unchanged", () => {
    saveTokenFile("myspec", { clientSecret: "plain-secret" });
    expect(getClientSecret("myspec")).toBe("plain-secret");
  });

  test("getClientSecret returns undefined when no secret is stored", () => {
    saveTokenFile("myspec", { tokens: { access_token: "x" } });
    expect(getClientSecret("myspec")).toBeUndefined();
  });

  test("saveTokenFile writes mode 0o600", () => {
    if (process.platform === "win32") return;
    saveTokenFile("myspec", { tokens: { access_token: "x" } });
    const mode = statSync(join(TEST_DIR, "myspec.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

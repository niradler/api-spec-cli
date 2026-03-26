import { describe, test, expect, mock } from "bun:test";
import { resolve } from "path";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => { captured = data; },
  err: (msg) => { captured = { error: msg }; },
}));

const { validateSpec } = await import("../src/commands/validate.js");
const fixturesDir = resolve(import.meta.dir, "fixtures");

describe("validate", () => {
  test("valid spec passes", async () => {
    captured = null;
    await validateSpec([resolve(fixturesDir, "openapi.json")]);
    expect(captured.valid).toBe(true);
    expect(captured.errors).toHaveLength(0);
    expect(captured.version).toBe("3.0.0");
    expect(captured.operationCount).toBe(3);
  });

  test("throws on missing file", async () => {
    await expect(validateSpec(["/nonexistent.json"])).rejects.toThrow("File not found");
  });

  test("throws on no args", async () => {
    await expect(validateSpec([])).rejects.toThrow("Usage");
  });
});

import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("should pass isolated MCP gateway protocol and security integration checks", () => {
  const home = mkdtempSync(join(tmpdir(), "spec-gateway-"));
  let output;
  try {
    output = execFileSync(
      "node",
      ["--test", "--test-reporter=tap", resolve(import.meta.dir, "support/gateway-check.mjs")],
      {
        encoding: "utf8",
        timeout: 60000,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          SPEC_NO_USAGE: "1",
          SPEC_NO_DOTENV: "1",
          SPEC_NO_CACHE: "1",
          SPEC_NO_POLICY: "",
          SPEC_URL: undefined,
        },
      }
    );
  } catch (error) {
    throw new Error(`${error.stdout || ""}\n${error.stderr || ""}`, { cause: error });
  }
  expect(output).toContain("# fail 0");
}, 65000);

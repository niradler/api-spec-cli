import { describe, test, expect, afterAll } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const bin = resolve(import.meta.dir, "../src/bin.ts");
const featuresServer = resolve(import.meta.dir, "support/mcp-features-server.mjs");
const home = mkdtempSync(join(tmpdir(), "spec-cli-mcp-features-cli-"));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  SPEC_NO_CACHE: "1",
  SPEC_NO_USAGE: "1",
  SPEC_NO_DOTENV: "1",
};

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("should pass isolated SDK resources and prompts checks", () => {
  let output;
  try {
    output = execFileSync(
      "node",
      ["--test", "--test-reporter=tap", resolve(import.meta.dir, "support/mcp-features-check.mjs")],
      { encoding: "utf8", timeout: 60000, env }
    );
  } catch (error) {
    throw new Error(`${error.stdout || ""}\n${error.stderr || ""}`, { cause: error });
  }
  expect(output).toContain("# fail 0");
}, 65000);

describe("CLI resources and prompts", () => {
  const source = ["--mcp-stdio", `node ${featuresServer.replaceAll("\\", "/")}`];

  function run(...args) {
    const result = execFileSync("node", [bin, ...args, ...source, "--format", "json"], {
      encoding: "utf-8",
      cwd: home,
      env,
      timeout: 15000,
    });
    return JSON.parse(result.trim());
  }

  test("lists and reads resources", () => {
    expect(run("resources").templates[0].name).toBe("page");
    expect(run("resource", "page", "--var", "slug=intro").contents[0].text).toBe("page:intro");
  });

  test("filters and pages resource listings", () => {
    const result = run("resources", "--filter", "readme", "--limit", "1");
    expect(result.total).toBe(1);
    expect(result.resources[0].uri).toBe("docs://readme");
    expect(run("resources", "--offset", "1").templates[0].name).toBe("page");
    expect(run("prompts", "--filter", "nope").prompts).toEqual([]);
  });

  test("list shows resource and prompt counts", () => {
    const result = run("list");
    expect(result.resources).toBe(2);
    expect(result.prompts).toBe(1);
  });

  test("lists and gets prompts", () => {
    expect(run("prompts").prompts[0].name).toBe("summarize");
    const result = run("prompt", "summarize", "--var", "topic=billing");
    expect(result.messages[0].content.text).toBe("Summarize billing");
  });

  test("takes prompt arguments from --data", () => {
    expect(run("prompts", "summarize", "--data", '{"topic":"x"}').arguments).toEqual({
      topic: "x",
    });
  });
});

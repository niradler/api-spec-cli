import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const bin = resolve(import.meta.dir, "../bin/spec.js");
const pathsUrl = new URL("../src/paths.js", import.meta.url).href;
let home;
let project;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "spec-home-"));
  project = join(home, "project");
  mkdirSync(project);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(args) {
  return execFileSync("node", [bin, ...args], {
    cwd: project,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: "utf8",
    timeout: 15000,
  });
}

describe("global home and startup migration", () => {
  test("should move all legacy data before reading the registry and preserve project config", () => {
    const legacy = join(home, "spec-cli-config");
    mkdirSync(join(legacy, "tokens"), { recursive: true });
    const registry = {
      mcp: {},
      openapi: { saved: { type: "openapi", enabled: true, source: "saved.json" } },
      graphql: {},
    };
    writeFileSync(join(legacy, "registry.json"), JSON.stringify(registry));
    writeFileSync(join(legacy, "tokens", "saved.json"), '{"tokens":{"access_token":"keep-me"}}');
    for (const dir of ["cache", "results", "policies"]) {
      mkdirSync(join(legacy, dir));
      writeFileSync(
        join(legacy, dir, "saved.json"),
        JSON.stringify({ cachedAt: Date.now(), data: {} })
      );
    }
    writeFileSync(join(legacy, "usage.json"), "{}");
    writeFileSync(join(legacy, "policy.json"), '{"rules":[]}');
    mkdirSync(join(project, ".spec-cli"));
    writeFileSync(
      join(project, ".spec-cli", "config.json"),
      '{"baseUrl":"https://project.example"}'
    );

    const result = JSON.parse(run(["specs", "--format", "json"]));
    expect(result.specs[0].name).toBe("saved");
    expect(existsSync(legacy)).toBe(false);
    const destination = join(home, ".spec-cli");
    expect(readFileSync(join(destination, "tokens", "saved.json"), "utf8")).toContain("keep-me");
    for (const dir of ["cache", "results", "policies"]) {
      expect(existsSync(join(destination, dir, "saved.json"))).toBe(true);
    }
    expect(readFileSync(join(project, ".spec-cli", "config.json"), "utf8")).toContain(
      "project.example"
    );
    expect(() => run(["help"])).not.toThrow();
    expect(existsSync(legacy)).toBe(false);
  });

  test("should leave both directories untouched when the new home already exists", () => {
    for (const dir of ["spec-cli-config", ".spec-cli"]) {
      mkdirSync(join(home, dir));
      writeFileSync(join(home, dir, "marker"), dir);
    }
    run(["help"]);
    for (const dir of ["spec-cli-config", ".spec-cli"]) {
      expect(readFileSync(join(home, dir, "marker"), "utf8")).toBe(dir);
    }
  });

  test("should boot without creating a global directory when no data is needed", () => {
    run(["help"]);
    expect(existsSync(join(home, "spec-cli-config"))).toBe(false);
    expect(existsSync(join(home, ".spec-cli"))).toBe(false);
  });

  test("should catch a failed rename and preserve the legacy directory", () => {
    mkdirSync(join(home, "spec-cli-config"));
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      fs.renameSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
      syncBuiltinESMExports();
      const { migrateLegacyHome } = await import(${JSON.stringify(pathsUrl)});
      migrateLegacyHome(${JSON.stringify(home)});
    `;
    const result = Bun.spawnSync(["node", "--input-type=module", "-e", script], { timeout: 15000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toContain("Could not migrate");
    expect(existsSync(join(home, "spec-cli-config"))).toBe(true);
    expect(existsSync(join(home, ".spec-cli"))).toBe(false);
  });

  test("should install the skill under spec-cli with matching metadata", () => {
    const result = JSON.parse(run(["skill", "install", "--format", "json"]));
    const expected = join(home, ".claude", "skills", "spec-cli", "SKILL.md");
    expect(result.path).toBe(expected);
    expect(result.skill).toBe("spec-cli");
    expect(readFileSync(expected, "utf8")).toContain("name: spec-cli");
    expect(existsSync(join(home, ".claude", "skills", "api-spec-cli"))).toBe(false);
  });

  test("should keep project settings local and spill results into the global home", () => {
    run(["config", "set", "base-url", "https://project.example"]);
    expect(existsSync(join(project, ".spec-cli", "config.json"))).toBe(true);
    const result = JSON.parse(run(["specs", "--max-bytes", "1", "--format", "json"]));
    expect(result.path.startsWith(join(home, ".spec-cli", "results"))).toBe(true);
    expect(JSON.parse(readFileSync(result.path, "utf8"))).toEqual({ specs: [] });
    expect(existsSync(join(home, "spec-cli-config"))).toBe(false);
  });

  test.each([
    "__proto__.polluted",
    "constructor.prototype.polluted",
    "headers.__proto__.polluted",
    "headers..bad",
  ])("should reject unsafe config key %s", (key) => {
    for (const action of ["set", "get", "unset"]) {
      expect(() => run(["config", action, key, ...(action === "set" ? ["true"] : [])])).toThrow();
    }
    expect(existsSync(join(project, ".spec-cli", "config.json"))).toBe(false);
  });
});

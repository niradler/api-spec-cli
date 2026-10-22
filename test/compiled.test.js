import { expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import packageInfo from "../package.json" with { type: "json" };

test("should boot, migrate, and install the skill from a standalone executable", () => {
  const home = mkdtempSync(join(tmpdir(), "spec-compiled-"));
  const bin = join(home, process.platform === "win32" ? "spec.exe" : "spec");
  try {
    execFileSync(
      "bun",
      ["build", "./bin/spec.js", "--compile", "--asset", "./src/skill", "--outfile", bin],
      {
        cwd: resolve(import.meta.dir, ".."),
        timeout: 30000,
        stdio: "pipe",
      }
    );
    const options = {
      cwd: home,
      env: { ...process.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
      timeout: 15000,
    };
    mkdirSync(join(home, "spec-cli-config"));
    writeFileSync(
      join(home, "spec-cli-config", "registry.json"),
      '{"mcp":{},"openapi":{},"graphql":{}}'
    );
    expect(execFileSync(bin, ["--version"], options).trim()).toBe(packageInfo.version);
    expect(existsSync(join(home, "spec-cli-config"))).toBe(false);
    expect(existsSync(join(home, ".spec-cli", "registry.json"))).toBe(true);
    const result = JSON.parse(execFileSync(bin, ["skill", "install", "--format", "json"], options));
    expect(result.skill).toBe("spec-cli");
    expect(readFileSync(result.path, "utf8")).toContain("name: spec-cli");
    expect(execFileSync(bin, ["help"], options)).toContain("Explore and call APIs");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 45000);

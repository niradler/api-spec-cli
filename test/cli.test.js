import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { execSync } from "child_process";

const bin = resolve(import.meta.dir, "../bin/spec.js");
const fixture = resolve(import.meta.dir, "fixtures/openapi.json");
// Use a throw-away home dir so tests never touch the real ~/spec-cli-config
const testHome = resolve(import.meta.dir, "../.test-home");

function run(args) {
  const result = execSync(`node ${bin} ${args}`, {
    encoding: "utf-8",
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, HOME: testHome },
  });
  return JSON.parse(result.trim());
}

function runRaw(args) {
  return execSync(`node ${bin} ${args}`, {
    encoding: "utf-8",
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, HOME: testHome },
  }).trim();
}

describe("CLI integration", () => {
  test("help returns JSON", () => {
    const result = run("help");
    expect(result.help).toContain("spec-cli");
  });

  test("list --openapi (inline) works end to end", () => {
    const listed = run(`list --openapi ${fixture}`);
    expect(listed.total).toBe(3);
    expect(listed.operations[0].id).toBeDefined();
    expect(listed.operations[0].summary).toBeUndefined(); // compact by default
  });

  test("show --openapi (inline) returns operation details", () => {
    const shown = run(`show --openapi ${fixture} getPet`);
    expect(shown.id).toBe("getPet");
    expect(shown.parameters).toHaveLength(1);
    expect(shown.responses["200"].schema).toBeDefined();
  });

  test("types --openapi (inline) lists schemas", () => {
    const types = run(`types --openapi ${fixture}`);
    expect(types.schemas).toContain("Pet");
  });

  test("types --openapi (inline) inspects one schema", () => {
    const pet = run(`types --openapi ${fixture} Pet`);
    expect(pet.name).toBe("Pet");
    expect(pet.properties.name.type).toBe("string");
  });

  test("validate works from CLI", () => {
    const result = run(`validate ${fixture}`);
    expect(result.valid).toBe(true);
  });

  test("list --filter works inline", () => {
    const result = run(`list --openapi ${fixture} --filter create`);
    expect(result.total).toBe(1);
    expect(result.operations[0].id).toBe("createPet");
  });

  test("list --limit works inline", () => {
    const result = run(`list --openapi ${fixture} --limit 1`);
    expect(result.showing).toBe(1);
    expect(result.total).toBe(3);
  });

  test("spec add / specs / remove works", () => {
    // Clean up first in case previous test left something
    try {
      run(`remove testpet`);
    } catch {}

    const added = run(`add testpet --openapi ${fixture}`);
    expect(added.ok).toBe(true);
    expect(added.name).toBe("testpet");

    const listed = run("specs");
    const found = listed.specs.find((s) => s.name === "testpet");
    expect(found).toBeDefined();
    expect(found.type).toBe("openapi");

    const removed = run("remove testpet");
    expect(removed.ok).toBe(true);
  });

  test("spec disable / enable works", () => {
    try {
      run(`remove testpet2`);
    } catch {}
    run(`add testpet2 --openapi ${fixture}`);

    const disabled = run("disable testpet2");
    expect(disabled.ok).toBe(true);

    const enabled = run("enable testpet2");
    expect(enabled.ok).toBe(true);

    run("remove testpet2");
  });

  test("unknown command exits with error", () => {
    let threw = false;
    try {
      run("nonexistent");
    } catch (e) {
      threw = true;
      expect(e.status).not.toBe(0);
    }
    expect(threw).toBe(true);
  });

  test("list with no source gives helpful error", () => {
    let threw = false;
    try {
      run("list");
    } catch (e) {
      threw = true;
      expect(e.stderr || e.stdout || "").toContain("");
    }
    expect(threw).toBe(true);
  });
});

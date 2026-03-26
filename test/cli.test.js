import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { execSync } from "child_process";

const bin = resolve(import.meta.dir, "../bin/spec.js");
const fixture = resolve(import.meta.dir, "fixtures/openapi.json");

function run(args) {
  const result = execSync(`node ${bin} ${args}`, {
    encoding: "utf-8",
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, HOME: "/tmp/spec-cli-test" },
  });
  return JSON.parse(result.trim());
}

describe("CLI integration", () => {
  test("help returns JSON", () => {
    const result = run("help");
    expect(result.help).toContain("spec-cli");
  });

  test("load + list + show + types works end to end", () => {
    // Load from fixture file
    const loaded = run(`load ${fixture}`);
    expect(loaded.ok).toBe(true);
    expect(loaded.type).toBe("openapi");
    expect(loaded.operationCount).toBe(3);

    // List operations
    const listed = run("list");
    expect(listed.total).toBe(3);
    expect(listed.operations[0].id).toBeDefined();
    // Compact by default - no summary
    expect(listed.operations[0].summary).toBeUndefined();

    // Show one operation
    const shown = run("show getPet");
    expect(shown.id).toBe("getPet");
    expect(shown.parameters).toHaveLength(1);
    expect(shown.responses["200"].schema).toBeDefined();

    // Types
    const types = run("types");
    expect(types.schemas).toContain("Pet");

    const pet = run("types Pet");
    expect(pet.name).toBe("Pet");
    expect(pet.properties.name.type).toBe("string");
  });

  test("validate works from CLI", () => {
    const result = run(`validate ${fixture}`);
    expect(result.valid).toBe(true);
  });

  test("list --filter works", () => {
    run(`load ${fixture}`);
    const result = run("list --filter create");
    expect(result.total).toBe(1);
    expect(result.operations[0].id).toBe("createPet");
  });

  test("list --limit works", () => {
    run(`load ${fixture}`);
    const result = run("list --limit 1");
    expect(result.showing).toBe(1);
    expect(result.total).toBe(3);
  });

  test("unknown command exits with error", () => {
    let threw = false;
    try {
      run("nonexistent");
    } catch (e) {
      threw = true;
      // execSync throws on non-zero exit code
      expect(e.status).not.toBe(0);
    }
    expect(threw).toBe(true);
  });
});

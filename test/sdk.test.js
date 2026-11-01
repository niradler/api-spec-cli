import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import {
  VERSION,
  createSpecClient,
  createToolCatalog,
  memoryRegistryStore,
  setSpecHome,
  setCacheDir,
  setUsageDir,
  setTokenDir,
} from "../src/index.ts";

const fixture = resolve(import.meta.dir, "fixtures", "openapi.json");
const home = mkdtempSync(join(tmpdir(), "spec-cli-sdk-"));

beforeAll(() => {
  setSpecHome(home);
  setCacheDir(join(home, "cache"));
  setUsageDir(join(home, "usage"));
  setTokenDir(join(home, "tokens"));
});

afterAll(() => {
  setSpecHome(undefined);
  setCacheDir(undefined);
  setUsageDir(undefined);
  setTokenDir(undefined);
  rmSync(home, { recursive: true, force: true });
});

function clientWithPets(execute) {
  const registry = memoryRegistryStore();
  const client = createSpecClient({ registry, ...(execute ? { execute } : {}) });
  client.specs.add("pets", { type: "openapi", source: fixture, baseUrl: "https://pets.test" });
  return client;
}

describe("SDK package", () => {
  test("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "package.json"), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("createSpecClient specs", () => {
  test("adds, lists, toggles and removes specs in an injected registry", () => {
    const client = clientWithPets();
    expect(client.specs.list().map((spec) => spec.name)).toEqual(["pets"]);
    expect(client.specs.get("pets")._section).toBe("openapi");

    client.specs.disable("pets");
    expect(client.specs.get("pets").enabled).toBe(false);
    client.specs.enable("pets");
    expect(client.specs.get("pets").enabled).toBe(true);

    const again = client.specs.add("pets", { type: "openapi", source: fixture });
    expect(again.overwritten).toBe(true);

    client.specs.remove("pets");
    expect(client.specs.list()).toEqual([]);
  });

  test("rejects unknown spec names", () => {
    const client = createSpecClient({ registry: memoryRegistryStore() });
    expect(() => client.specs.get("missing")).toThrow("No spec named 'missing'");
  });
});

describe("createSpecClient operations", () => {
  test("lists, shows and searches operations of a registered spec", async () => {
    const client = clientWithPets();
    const list = await client.operations.list("pets");
    expect(list.operations.map((op) => op.id)).toEqual(["listPets", "createPet", "getPet"]);

    const shown = await client.operations.show("pets", "getPet");
    expect(shown.path).toBe("/pets/{petId}");

    const found = await client.operations.search("pet by id");
    expect(found.results[0].spec).toBe("pets");
    expect(found.results[0].matches[0].id).toBe("getPet");
    expect((await client.tools.search("pet by id"))[0].id).toBe("pets.getPet");

    const grep = await client.operations.grep("*pet*");
    expect(grep.total).toBe(3);
  });

  test("calls an operation through the injected executor", async () => {
    const calls = [];
    const client = clientWithPets(async (_spec, entry, target, request) => {
      calls.push({ name: entry.name, target, request });
      return { status: 200, body: { ok: true } };
    });
    const result = await client.operations.call("pets", "getPet", { vars: { petId: "7" } });
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(calls).toEqual([{ name: "pets", target: "getPet", request: { vars: { petId: "7" } } }]);
  });
});

describe("tool catalog", () => {
  test("discovers, describes and calls tools with schema validation", async () => {
    const calls = [];
    const client = clientWithPets(async (_spec, _entry, target, request) => {
      calls.push({ target, request });
      return { status: 200, body: { id: 7 } };
    });
    const { tools } = client;

    expect(tools.specs().map((spec) => spec.name)).toEqual(["pets"]);
    expect((await tools.tools("pets")).map((tool) => tool.id)).toEqual([
      "pets.listPets",
      "pets.createPet",
      "pets.getPet",
    ]);
    expect((await tools.search("getpet")).map((tool) => tool.id)).toEqual(["pets.getPet"]);

    const described = await tools.describe("pets.getPet");
    expect(described.inputSchema.properties.path.required).toEqual(["petId"]);

    const invalid = await tools.call("pets.getPet", {});
    expect(invalid.isError).toBe(true);
    expect(calls).toHaveLength(0);

    const result = await tools.call("pets.getPet", { path: { petId: 7 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: 200, body: { id: 7 } });
    expect(calls[0].target).toBe("getPet");
    expect(calls[0].request.vars).toEqual({ petId: "7" });
  });

  test("scopes intersect exact tool ids across every scope", async () => {
    const client = clientWithPets();
    const catalog = createToolCatalog({
      entries: () => client.specs.list({ compact: false }).map((s) => client.specs.get(s.name)),
      scopes: [
        { specs: ["pets"] },
        { tools: ["pets.getPet", "pets.listPets"] },
        { disabledTools: ["pets.listPets"] },
      ],
    });
    expect((await catalog.tools()).map((tool) => tool.id)).toEqual(["pets.getPet"]);
    await expect(catalog.find("pets.createPet")).rejects.toThrow();
  });
});

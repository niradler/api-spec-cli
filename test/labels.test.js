import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MAX_LABELS,
  createSpecClient,
  createToolCatalog,
  entryFromSource,
  matchesLabels,
  memoryRegistryStore,
  normalizeLabels,
  parseSelection,
} from "../src/index.ts";
import { createGateway } from "../src/gateway.ts";
import { parseArgs } from "../src/args.ts";
import { sourceFromFlags } from "../src/sources.ts";

const bin = resolve(import.meta.dir, "../src/bin.ts");
const fixture = resolve(import.meta.dir, "fixtures/openapi.json");

const DOCUMENTS = {
  billing: {
    type: "openapi",
    operations: [
      { id: "listInvoices", method: "GET", path: "/invoices", summary: "List invoices" },
    ],
  },
  pets: {
    type: "openapi",
    operations: [{ id: "listPets", method: "GET", path: "/pets", summary: "List pets" }],
  },
  plain: {
    type: "openapi",
    operations: [{ id: "listThings", method: "GET", path: "/things", summary: "List things" }],
  },
};

function labelledClient() {
  const loads = [];
  const client = createSpecClient({
    registry: memoryRegistryStore(),
    loadSpec: async (entry) => {
      loads.push(entry.name);
      return DOCUMENTS[entry.name];
    },
  });
  const source = (labels) => ({ type: "openapi", source: fixture, labels });
  client.specs.add("billing", source(["orc", "orc:project=a", "team:billing"]));
  client.specs.add("pets", source(["orc", "orc:project=b"]));
  client.specs.add("plain", { type: "openapi", source: fixture });
  return { client, loads };
}

describe("label validation", () => {
  test("sorts, deduplicates and accepts the allowed alphabet", () => {
    expect(normalizeLabels(["b", "a", "b", "orc:project=x.y_z-1"])).toEqual([
      "a",
      "b",
      "orc:project=x.y_z-1",
    ]);
    expect(normalizeLabels(undefined)).toEqual([]);
    expect(normalizeLabels([])).toEqual([]);
  });

  test("rejects invalid labels naming the offender, without lowercasing", () => {
    expect(() => normalizeLabels(["ok", "Upper"])).toThrow("Invalid label 'Upper'");
    expect(() => normalizeLabels(["has space"])).toThrow("Invalid label 'has space'");
    expect(() => normalizeLabels([""])).toThrow("Invalid label ''");
    expect(() => normalizeLabels(["a".repeat(65)])).toThrow("Invalid label");
    expect(() => normalizeLabels([5])).toThrow("Invalid label '5'");
    expect(() => normalizeLabels("orc")).toThrow("array");
    expect(normalizeLabels(["a".repeat(64)])).toHaveLength(1);
  });

  test("caps the number of labels after deduplication", () => {
    const many = Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`);
    expect(normalizeLabels([...many, ...many])).toHaveLength(MAX_LABELS);
    expect(() => normalizeLabels([...many, "extra"])).toThrow("Too many labels");
  });

  test("matchesLabels supports any, all and no filter", () => {
    const entry = { labels: ["a", "b"] };
    expect(matchesLabels(entry, undefined)).toBe(true);
    expect(matchesLabels(entry, [])).toBe(false);
    expect(matchesLabels(entry, [], "all")).toBe(false);
    expect(() => matchesLabels(entry, ["a"], "ALL")).toThrow("Invalid label match");
    expect(matchesLabels({ labels: "abc" }, ["a"])).toBe(false);
    expect(matchesLabels(entry, ["a", "z"])).toBe(true);
    expect(matchesLabels(entry, ["a", "z"], "all")).toBe(false);
    expect(matchesLabels(entry, ["a", "b"], "all")).toBe(true);
    expect(matchesLabels({}, ["a"])).toBe(false);
  });

  test("entries store normalized labels and omit the field when empty", () => {
    expect(entryFromSource({ type: "openapi", source: "x", labels: ["b", "a"] }).labels).toEqual([
      "a",
      "b",
    ]);
    expect("labels" in entryFromSource({ type: "openapi", source: "x" })).toBe(false);
    expect("labels" in entryFromSource({ type: "openapi", source: "x", labels: [] })).toBe(false);
    expect(() => entryFromSource({ type: "openapi", source: "x", labels: ["Bad"] })).toThrow("Bad");
  });
});

describe("flag parsing", () => {
  test("--label repeats and --all-labels never swallows the next word", () => {
    const { flags, positional } = parseArgs(["--label", "a", "--label=b", "--all-labels", "query"]);
    expect(flags.label).toEqual(["a", "b"]);
    expect(flags["all-labels"]).toBe(true);
    expect(positional).toEqual(["query"]);
    const explicit = parseArgs(["--all-labels", "false", "query"]);
    expect(explicit.flags["all-labels"]).toBe("false");
    expect(explicit.positional).toEqual(["query"]);
    expect(
      sourceFromFlags(parseArgs(["--openapi", "u", "--label", "z", "--label", "a"]).flags).labels
    ).toEqual(["z", "a"]);
    expect(() => sourceFromFlags(parseArgs(["--openapi", "u", "--label"]).flags)).toThrow(
      "--label requires a value"
    );
  });
});

describe("SDK specs", () => {
  test("list without arguments is unchanged for unlabeled specs", () => {
    const client = createSpecClient({ registry: memoryRegistryStore() });
    client.specs.add("plain", { type: "openapi", source: fixture });
    expect(client.specs.list()).toEqual([
      { name: "plain", type: "openapi", description: null, enabled: true },
    ]);
  });

  test("list reports labels and filters by any or all", () => {
    const { client } = labelledClient();
    const names = (options) => client.specs.list(options).map((spec) => spec.name);
    expect(client.specs.list().find((spec) => spec.name === "billing").labels).toEqual([
      "orc",
      "orc:project=a",
      "team:billing",
    ]);
    expect(names({ labels: ["orc"] })).toEqual(["billing", "pets"]);
    expect(names({ labels: ["orc:project=a", "orc:project=b"] })).toEqual(["billing", "pets"]);
    expect(names({ labels: ["orc", "team:billing"], match: "all" })).toEqual(["billing"]);
    expect(names({ labels: ["nothing"] })).toEqual([]);
    expect(names({ labels: [] })).toEqual([]);
    expect(names({})).toEqual(["billing", "pets", "plain"]);
    expect(() => names({ labels: ["orc"], match: "every" })).toThrow("Invalid label match");
    expect(names({ labels: ["orc"], filter: "pet" })).toEqual(["pets"]);
    expect(client.specs.list({ labels: ["orc"], compact: false })[0].labels).toContain("orc");
    expect(() => client.specs.list({ labels: ["Bad"] })).toThrow("Invalid label 'Bad'");
  });

  test("addLabels and removeLabels persist through the registry store", () => {
    const { client } = labelledClient();
    expect(client.specs.addLabels("plain", ["z", "a", "a"])).toEqual(["a", "z"]);
    expect(client.specs.get("plain").labels).toEqual(["a", "z"]);
    expect(client.specs.removeLabels("plain", ["a", "missing"])).toEqual(["z"]);
    expect(client.specs.removeLabels("plain", ["z"])).toEqual([]);
    expect("labels" in client.specs.get("plain")).toBe(false);
  });

  test("addLabels rejects bad input and unknown specs without writing", () => {
    const { client } = labelledClient();
    expect(() => client.specs.addLabels("plain", ["ok", "Bad"])).toThrow("Invalid label 'Bad'");
    expect("labels" in client.specs.get("plain")).toBe(false);
    expect(() => client.specs.addLabels("nope", ["a"])).toThrow("No spec named 'nope'");
    expect(() => client.specs.removeLabels("nope", ["a"])).toThrow("No spec named 'nope'");
    const full = Array.from({ length: MAX_LABELS }, (_, i) => `l${i}`);
    client.specs.addLabels("plain", full);
    expect(() => client.specs.addLabels("plain", ["one-more"])).toThrow("Too many labels");
    expect(client.specs.get("plain").labels).toHaveLength(MAX_LABELS);
  });

  test("registry files without labels keep working", () => {
    const client = createSpecClient({
      registry: memoryRegistryStore({
        openapi: { old: { type: "openapi", enabled: true, source: fixture, config: {} } },
      }),
    });
    expect(client.specs.list({ labels: ["x"] })).toEqual([]);
    expect(client.specs.addLabels("old", ["x"])).toEqual(["x"]);
  });

  test("label changes repair malformed stored labels", () => {
    const client = createSpecClient({
      registry: memoryRegistryStore({
        openapi: {
          bad: { type: "openapi", enabled: true, source: fixture, config: {}, labels: "orc" },
          mixed: {
            type: "openapi",
            enabled: true,
            source: fixture,
            config: {},
            labels: ["orc", "Bad Label"],
          },
        },
      }),
    });
    expect(client.specs.list({ labels: ["orc"] }).map((spec) => spec.name)).toEqual(["mixed"]);
    expect("labels" in client.specs.list().find((spec) => spec.name === "bad")).toBe(false);
    expect(client.specs.addLabels("bad", ["orc"])).toEqual(["orc"]);
    expect(client.specs.removeLabels("mixed", ["missing"])).toEqual(["orc"]);
  });
});

describe("SDK search", () => {
  test("filters by labels, any or all, and loads only matching specs", async () => {
    const { client, loads } = labelledClient();
    const specsOf = (result) => [...new Set(result.results.map((hit) => hit.spec))].sort();
    expect(specsOf(await client.operations.search("*", { labels: ["orc"] }))).toEqual([
      "billing",
      "pets",
    ]);
    expect(loads.sort()).toEqual(["billing", "pets"]);
    const all = await client.operations.search("*", {
      labels: ["orc", "team:billing"],
      match: "all",
    });
    expect(specsOf(all)).toEqual(["billing"]);
    expect(specsOf(await client.operations.search("*"))).toEqual(["billing", "pets", "plain"]);
  });

  test("labels combine with spec: both must pass", async () => {
    const { client } = labelledClient();
    const both = await client.operations.search("*", { spec: ["pets", "plain"], labels: ["orc"] });
    expect(both.results.map((hit) => hit.spec)).toEqual(["pets"]);
    const none = await client.operations.search("*", { spec: "plain", labels: ["orc"] });
    expect(none).toEqual({ query: "*", total: 0, showing: 0, results: [] });
  });

  test("a label that matches nothing returns no results instead of searching everything", async () => {
    const { client, loads } = labelledClient();
    const result = await client.operations.search("*", { labels: ["ghost"] });
    expect(result.total).toBe(0);
    expect(loads).toEqual([]);
  });
});

describe("catalog label scope", () => {
  test("never loads or exposes specs outside the label scope", async () => {
    const { client } = labelledClient();
    const loaded = [];
    const catalog = createToolCatalog({
      entries: () => client.specs.list({ compact: false }),
      load: async (entry) => {
        loaded.push(entry.name);
        return DOCUMENTS[entry.name];
      },
      scopes: [{ labels: ["orc:project=a"] }],
    });
    expect(catalog.specs().map((entry) => entry.name)).toEqual(["billing"]);
    expect((await catalog.tools()).map((tool) => tool.id)).toEqual(["billing.listInvoices"]);
    expect((await catalog.search("*")).map((tool) => tool.id)).toEqual(["billing.listInvoices"]);
    await expect(catalog.tools("pets")).rejects.toThrow("Unavailable spec");
    await expect(catalog.find("pets.listPets")).rejects.toThrow("Unavailable tool");
    await expect(catalog.call("plain.listThings", {})).rejects.toThrow("Unavailable tool");
    expect(loaded).not.toContain("pets");
    expect(loaded).not.toContain("plain");
    expect(new Set(loaded)).toEqual(new Set(["billing"]));
  });

  test("labelMatch all requires every label and an empty label scope allows nothing", async () => {
    const { client } = labelledClient();
    const entries = () => client.specs.list({ compact: false });
    const names = (scope) =>
      createToolCatalog({ entries, scopes: [scope] })
        .specs()
        .map((e) => e.name);
    expect(names({ labels: ["orc", "team:billing"], labelMatch: "all" })).toEqual(["billing"]);
    expect(names({ labels: ["orc", "team:billing"] })).toEqual(["billing", "pets"]);
    expect(names({ labels: [] })).toEqual([]);
    expect(names({})).toEqual(["billing", "pets", "plain"]);
  });

  test("client scopes apply the same filter to the built-in catalog", () => {
    const client = createSpecClient({
      registry: memoryRegistryStore(),
      scopes: [{ labels: ["orc"] }],
    });
    client.specs.add("a", { type: "openapi", source: fixture, labels: ["orc"] });
    client.specs.add("b", { type: "openapi", source: fixture });
    expect(client.tools.specs().map((entry) => entry.name)).toEqual(["a"]);
  });
});

describe("gateway labels", () => {
  test("parseSelection accepts labels like specs and tools", () => {
    expect(parseSelection(new URLSearchParams("labels=orc,orc:project=a,orc")).labels).toEqual([
      "orc",
      "orc:project=a",
    ]);
    expect(parseSelection(new URLSearchParams("mode=tools&labels=orc")).mode).toBe("tools");
    expect(parseSelection().labels).toBeUndefined();
  });

  test("parseSelection rejects invalid labels and still rejects other or repeated keys", () => {
    for (const query of [
      "labels=",
      "labels=a,,b",
      "labels=Upper",
      "labels=has%20space",
      `labels=${"a".repeat(65)}`,
      "labels=a&labels=b",
      "label=a",
      "other=1",
    ])
      expect(() => parseSelection(new URLSearchParams(query))).toThrow();
    expect(() => parseSelection(new URLSearchParams("labels=Upper"))).toThrow(
      "Invalid labels filter"
    );
    expect(() => parseSelection(new URLSearchParams("other=1"))).toThrow(
      "Unknown or repeated gateway parameter"
    );
  });

  test("a gateway built from a labels selection exposes only matching specs", async () => {
    const { client } = labelledClient();
    const gateway = createGateway(
      parseSelection(new URLSearchParams("labels=team:billing")),
      {},
      {
        entries: () => client.specs.list({ compact: false }),
        load: async (entry) => DOCUMENTS[entry.name],
      }
    );
    expect(gateway.specs().map((entry) => entry.name)).toEqual(["billing"]);
    expect((await gateway.tools()).map((tool) => tool.id)).toEqual(["billing.listInvoices"]);
  });
});

describe("label CLI", () => {
  const home = mkdtempSync(join(tmpdir(), "spec-cli-labels-"));
  const project = join(home, "project");
  mkdirSync(project);

  function spec(...args) {
    return execFileSync("node", [bin, ...args, "--format", "json"], {
      encoding: "utf-8",
      cwd: project,
      timeout: 20000,
      env: { ...process.env, SPEC_HOME: join(home, ".spec-cli"), HOME: home, USERPROFILE: home },
    }).trim();
  }

  function json(...args) {
    return JSON.parse(spec(...args));
  }

  function fails(...args) {
    try {
      spec(...args);
    } catch (error) {
      return `${error.stdout}${error.stderr}`;
    }
    throw new Error("expected failure");
  }

  test("add --label, label add/remove, and specs filters", () => {
    expect(json("specs").specs).toEqual([]);
    json("add", "a", "--openapi", fixture, "--label", "orc", "--label", "orc:project=x");
    json("add", "b", "--openapi", fixture, "--label", "orc");
    json("add", "c", "--openapi", fixture);

    const byName = (specs) => Object.fromEntries(specs.map((s) => [s.name, s]));
    const listed = byName(json("specs").specs);
    expect(listed.a.labels).toEqual(["orc", "orc:project=x"]);
    expect("labels" in listed.c).toBe(false);

    const names = (...args) => json("specs", ...args).specs.map((s) => s.name);
    expect(names("--label", "orc")).toEqual(["a", "b"]);
    expect(names("--label", "orc:project=x", "--label", "nope")).toEqual(["a"]);
    expect(names("--label", "orc", "--label", "orc:project=x", "--all-labels")).toEqual(["a"]);
    expect(names("--all-labels", "--label", "orc", "--label", "orc:project=x")).toEqual(["a"]);

    expect(json("label", "add", "c", "team:z", "env=prod", "env=prod")).toEqual({
      ok: true,
      spec: "c",
      labels: ["env=prod", "team:z"],
    });
    expect(names("--label", "env=prod")).toEqual(["c"]);
    expect(json("label", "remove", "c", "env=prod").labels).toEqual(["team:z"]);
    expect(json("label", "remove", "c", "team:z").labels).toEqual([]);

    const stored = JSON.parse(readFileSync(join(home, ".spec-cli", "registry.json"), "utf8"));
    expect(stored.openapi.a.labels).toEqual(["orc", "orc:project=x"]);
    expect("labels" in stored.openapi.c).toBe(false);
  });

  test("search --label scopes results and combines with --spec", () => {
    const hitSpecs = (...args) => [
      ...new Set(json("search", "*", ...args).results.map((h) => h.spec)),
    ];
    expect(hitSpecs("--label", "orc:project=x")).toEqual(["a"]);
    expect(hitSpecs("--label", "orc").sort()).toEqual(["a", "b"]);
    expect(hitSpecs("--label", "orc", "--label", "orc:project=x", "--all-labels")).toEqual(["a"]);
    expect(hitSpecs("--label", "orc", "--spec", "b")).toEqual(["b"]);
    expect(json("search", "*", "--label", "orc:project=x", "--spec", "b").total).toBe(0);
    expect(hitSpecs().sort()).toEqual(["a", "b", "c"]);
  });

  test("invalid labels and bad usage fail with a clear message", () => {
    expect(fails("add", "d", "--openapi", fixture, "--label", "Bad")).toContain(
      "Invalid label 'Bad'"
    );
    expect(fails("label", "add", "a", "Has Space")).toContain("Invalid label 'Has Space'");
    expect(fails("specs", "--label", "UP")).toContain("Invalid label 'UP'");
    expect(fails("label", "add", "ghost", "x")).toContain("No spec named 'ghost'");
    expect(json("specs").specs.map((s) => s.name)).not.toContain("d");
  });

  test("help covers labels", () => {
    expect(spec("label", "--help")).toContain("spec label add|remove");
    expect(spec("specs", "--help")).toContain("--label");
    rmSync(home, { recursive: true, force: true });
  });
});

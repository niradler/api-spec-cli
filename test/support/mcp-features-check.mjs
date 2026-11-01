import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createSpecClient,
  memoryRegistryStore,
  setLocalPolicyFile,
  setPoliciesDir,
  setPolicyDir,
} from "../../src/index.ts";

const featuresServer = resolve(import.meta.dirname, "mcp-features-server.mjs");
const partialServer = resolve(import.meta.dirname, "mcp-partial-server.mjs");
const echoServer = resolve(import.meta.dirname, "mcp-echo-server.mjs");
const openapiFixture = resolve(import.meta.dirname, "../fixtures/openapi.json");
const home = mkdtempSync(join(tmpdir(), "spec-cli-mcp-features-"));
const policyDir = join(home, "policy");
mkdirSync(policyDir, { recursive: true });
setPolicyDir(policyDir);
setLocalPolicyFile(join(policyDir, "local-policy.json"));
setPoliciesDir(null);

const client = createSpecClient({ registry: memoryRegistryStore() });
client.specs.add("docs", { type: "stdio", command: "node", args: [featuresServer] });
client.specs.add("echo", { type: "stdio", command: "node", args: [echoServer] });
client.specs.add("pets", { type: "openapi", source: openapiFixture });
client.specs.add("broken", { type: "stdio", command: "node", args: [partialServer, "broken"] });
client.specs.add("notes", {
  type: "stdio",
  command: "node",
  args: [partialServer, "resources-only"],
});
client.specs.add("scoped", {
  type: "stdio",
  command: "node",
  args: [featuresServer],
  allowedTools: ["ping", "resource:docs://readme", "prompt:summarize"],
});
client.specs.add("hidden", {
  type: "stdio",
  command: "node",
  args: [featuresServer],
  disabledTools: ["resource:docs://pages/*"],
});

function withPolicy(rules) {
  writeFileSync(join(policyDir, "policy.json"), JSON.stringify({ rules }));
}

function clearPolicy() {
  rmSync(join(policyDir, "policy.json"), { force: true });
}

after(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SDK resources", () => {
  test("lists resources and templates", async () => {
    assert.deepEqual(await client.resources.list("docs"), {
      total: 2,
      showing: 2,
      offset: 0,
      resources: [
        {
          uri: "docs://readme",
          name: "readme",
          description: "Project readme",
          mimeType: "text/markdown",
        },
      ],
      templates: [
        {
          uriTemplate: "docs://pages/{slug}",
          name: "page",
          description: "A docs page",
          mimeType: "text/plain",
        },
      ],
    });
  });

  test("filters and pages resources across resources and templates", async () => {
    const filtered = await client.resources.list("docs", { filter: "pages" });
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.resources, []);
    assert.equal(filtered.templates[0].name, "page");
    const paged = await client.resources.list("docs", { offset: 1, limit: 1 });
    assert.deepEqual(
      { total: paged.total, showing: paged.showing, offset: paged.offset },
      { total: 2, showing: 1, offset: 1 }
    );
    assert.equal(paged.templates[0].name, "page");
    const first = await client.resources.list("docs", { limit: 1 });
    assert.equal(first.limit, 1);
    assert.equal(first.resources[0].name, "readme");
  });

  test("list reports resource and prompt counts for MCP specs", async () => {
    const docs = await client.operations.list("docs");
    assert.equal(docs.resources, 2);
    assert.equal(docs.prompts, 1);
    const echo = await client.operations.list("echo");
    assert.equal("resources" in echo || "prompts" in echo, false);
  });

  test("reads a resource by name or URI", async () => {
    const byName = await client.resources.read("docs", "README");
    assert.equal(byName.uri, "docs://readme");
    assert.equal(byName.contents[0].text, "# Docs");
    const byUri = await client.resources.read("docs", "docs://readme");
    assert.equal(byUri.contents[0].text, "# Docs");
  });

  test("expands a template by name or literal template", async () => {
    assert.deepEqual(await client.resources.read("docs", "page", { vars: { slug: "intro" } }), {
      uri: "docs://pages/intro",
      contents: [{ uri: "docs://pages/intro", text: "page:intro" }],
    });
    const literal = await client.resources.read("docs", "docs://pages/{slug}", {
      vars: { slug: "faq" },
    });
    assert.equal(literal.contents[0].text, "page:faq");
  });

  test("reports missing template variables and unknown resources", async () => {
    await assert.rejects(client.resources.read("docs", "page"), {
      message: "Missing resource template variables: slug. Pass --var slug=<value>",
    });
    await assert.rejects(client.resources.read("docs", "nope"), /Resource not found: nope/);
  });

  test("policy rules match resource:<uri>", async () => {
    withPolicy([{ id: "no-pages", tool: "resource:docs://pages/*", message: "pages blocked" }]);
    try {
      await assert.rejects(
        client.resources.read("docs", "page", { vars: { slug: "secret" } }),
        /pages blocked/
      );
      assert.equal((await client.resources.read("docs", "readme")).uri, "docs://readme");
    } finally {
      clearPolicy();
    }
  });
});

describe("tool filters and URI forms", () => {
  test("allowedTools scopes resources, templates and prompts", async () => {
    const listed = await client.resources.list("scoped");
    assert.deepEqual(
      listed.resources.map((r) => r.uri),
      ["docs://readme"]
    );
    assert.deepEqual(listed.templates, []);
    assert.equal((await client.prompts.list("scoped")).total, 1);
    await assert.rejects(
      client.resources.read("scoped", "docs://pages/intro"),
      /excluded by the spec's tool filter/
    );
  });

  test("disabledTools blocks reads in any URI form", async () => {
    assert.deepEqual((await client.resources.list("hidden")).templates, []);
    for (const uri of ["docs://pages/a", "docs://pages/x/../a", "docs://%70ages/a"]) {
      await assert.rejects(client.resources.read("hidden", uri), /excluded/, uri);
    }
  });

  test("policy rules see normalized and decoded URIs", async () => {
    withPolicy([{ id: "no-secret", tool: "resource:docs://pages/secret*", message: "secret" }]);
    try {
      for (const uri of ["docs://pages/%73ecret", "docs://pages/x/../secret"]) {
        await assert.rejects(client.resources.read("docs", uri), /secret/, uri);
      }
    } finally {
      clearPolicy();
    }
  });

  test("filter matches values, not field names", async () => {
    assert.equal((await client.resources.list("docs", { filter: "uri" })).total, 0);
  });
});

describe("SDK prompts", () => {
  test("lists prompts with arguments", async () => {
    assert.deepEqual(await client.prompts.list("docs"), {
      total: 1,
      showing: 1,
      offset: 0,
      prompts: [
        {
          name: "summarize",
          description: "Summarize a topic",
          arguments: [
            { name: "topic", description: "Topic", required: true },
            { name: "tone", description: null, required: false },
          ],
        },
      ],
    });
  });

  test("gets a prompt with arguments", async () => {
    const result = await client.prompts.get("docs", "summarize", {
      arguments: { topic: "billing", tone: "brief" },
    });
    assert.deepEqual(result, {
      prompt: "summarize",
      arguments: { topic: "billing", tone: "brief" },
      description: "Summary prompt",
      messages: [{ role: "user", content: { type: "text", text: "Summarize billing (brief)" } }],
    });
  });

  test("filters prompts", async () => {
    const result = await client.prompts.list("docs", { filter: "nothing-matches" });
    assert.deepEqual(result.prompts, []);
    assert.equal(result.total, 0);
  });

  test("policy rules match prompt:<name> and tool rules do not", async () => {
    withPolicy([{ id: "tool-rule", tool: "summarize", message: "tool rule" }]);
    try {
      const result = await client.prompts.get("docs", "summarize", { arguments: { topic: "x" } });
      assert.equal(result.prompt, "summarize");
      withPolicy([{ id: "no-summary", tool: "prompt:summarize", message: "prompt blocked" }]);
      await assert.rejects(
        client.prompts.get("docs", "summarize", { arguments: { topic: "y" } }),
        /prompt blocked/
      );
    } finally {
      clearPolicy();
    }
  });

  test("reports missing required arguments before calling the server", async () => {
    await assert.rejects(client.prompts.get("docs", "summarize"), {
      message: "Missing required prompt arguments: topic. Pass --var topic=<value>",
    });
    await assert.rejects(client.prompts.get("docs", "nope"), /Prompt not found: nope/);
  });
});

describe("unsupported specs", () => {
  test("rejects non-MCP specs", async () => {
    await assert.rejects(client.resources.list("pets"), {
      message: "Resources are only available for MCP specs (spec type: openapi)",
    });
    await assert.rejects(client.prompts.list("pets"), /Prompts are only available for MCP specs/);
  });

  test("a failing resources listing does not break tools", async () => {
    const result = await client.operations.call("broken", "ping");
    assert.equal(result.content[0].text, "pong");
    await assert.rejects(
      client.resources.list("broken"),
      /failed to list resources: .*backend down.*spec refresh/
    );
  });

  test("servers without tools still expose resources", async () => {
    assert.equal((await client.operations.list("notes")).total, 0);
    assert.equal((await client.resources.list("notes")).resources[0].uri, "notes://today");
    assert.equal(
      (await client.resources.read("notes", "today")).contents[0].text,
      "read:notes://today"
    );
  });

  test("reports servers without the capability", async () => {
    await assert.rejects(client.resources.list("echo"), /does not expose resources/);
    await assert.rejects(client.prompts.list("echo"), /does not expose prompts/);
  });
});

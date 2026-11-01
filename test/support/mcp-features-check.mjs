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

after(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SDK resources", () => {
  test("lists resources and templates", async () => {
    assert.deepEqual(await client.resources.list("docs"), {
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

  test("policy rules match the resolved resource URI", async () => {
    const file = join(policyDir, "policy.json");
    writeFileSync(
      file,
      JSON.stringify({
        rules: [{ id: "no-pages", tool: "docs://pages/*", message: "pages blocked" }],
      })
    );
    try {
      await assert.rejects(
        client.resources.read("docs", "page", { vars: { slug: "secret" } }),
        /pages blocked/
      );
    } finally {
      rmSync(file);
    }
  });
});

describe("SDK prompts", () => {
  test("lists prompts with arguments", async () => {
    assert.deepEqual(await client.prompts.list("docs"), {
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

  test("reports servers without the capability", async () => {
    await assert.rejects(client.resources.list("echo"), /does not expose resources/);
    await assert.rejects(client.prompts.list("echo"), /does not expose prompts/);
  });
});

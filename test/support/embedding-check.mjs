import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  McpAuthRequiredError,
  createMcpClient,
  createMcpSession,
  createSpecClient,
  memoryRegistryStore,
  setCacheDir,
  setProjectDir,
  setSpecHome,
  setTokenDir,
  setUsageDir,
} from "../../src/index.ts";
import { getConfig, writeStore } from "../../src/store.ts";

const home = mkdtempSync(join(tmpdir(), "spec-embed-"));
const echoServer = resolve(import.meta.dirname, "mcp-echo-server.mjs");

before(() => {
  setSpecHome(home);
  setCacheDir(join(home, "cache"));
  setUsageDir(join(home, "usage"));
  setTokenDir(join(home, "tokens"));
});

after(() => {
  setProjectDir(undefined);
  rmSync(home, { recursive: true, force: true });
});

function openapi(file, operationId, server) {
  const path = join(home, file);
  writeFileSync(
    path,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: file, version: "1" },
      servers: [{ url: server }],
      paths: {
        "/items": {
          post: {
            operationId,
            requestBody: {
              content: { "application/json": { schema: { type: "object" } } },
            },
            responses: { 200: { description: "ok" } },
          },
        },
      },
    })
  );
  return path;
}

test("clients with the same spec name never share cached documents", async () => {
  const a = createSpecClient({ registry: memoryRegistryStore() });
  const b = createSpecClient({ registry: memoryRegistryStore() });
  a.specs.add("api", { type: "openapi", source: openapi("a.json", "fromA", "https://a.test") });
  b.specs.add("api", { type: "openapi", source: openapi("b.json", "fromB", "https://b.test") });

  assert.deepEqual(
    (await a.operations.list("api")).operations.map((op) => op.id),
    ["fromA"]
  );
  assert.deepEqual(
    (await b.operations.list("api")).operations.map((op) => op.id),
    ["fromB"]
  );
  assert.equal((await b.operations.load("api")).spec.servers[0].url, "https://b.test");
});

test("catalog calls send request bodies as JSON text", async () => {
  const requests = [];
  const client = createSpecClient({
    registry: memoryRegistryStore(),
    execute: async (_spec, _entry, _target, request) => {
      requests.push(request);
      return { status: 200, body: {} };
    },
  });
  client.specs.add("bodies", {
    type: "openapi",
    source: openapi("bodies.json", "createItem", "https://bodies.test"),
  });
  await client.tools.call("bodies.createItem", { body: { name: "x" } });
  assert.equal(requests[0].data, '{"name":"x"}');
});

test("SDK clients fail fast instead of starting browser OAuth", async () => {
  let mcpHits = 0;
  const server = createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url.startsWith("/mcp")) {
      mcpHits++;
      res.writeHead(401).end();
      return;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        })
      );
      return;
    }
    if (req.url === "/register") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res
          .writeHead(201, { "Content-Type": "application/json" })
          .end(JSON.stringify({ ...JSON.parse(body), client_id: "test-client" }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    const client = createSpecClient({ registry: memoryRegistryStore() });
    client.specs.add("secure", {
      type: "http",
      url: `http://127.0.0.1:${server.address().port}/mcp`,
    });
    await assert.rejects(client.operations.list("secure"), McpAuthRequiredError);
    assert.equal(mcpHits, 1);
    await client.close();
  } finally {
    server.close();
  }
});

test("closing one session leaves other sessions' MCP clients open", async () => {
  const target = { type: "stdio", command: process.execPath, args: [echoServer] };
  const first = createMcpSession();
  const second = createMcpSession();
  const a = await first.run(() => createMcpClient(target));
  const b = await second.run(() => createMcpClient(target));
  try {
    await first.close();
    await assert.rejects(a.listTools());
    assert.deepEqual(
      (await b.listTools()).tools.map((tool) => tool.name),
      ["ping"]
    );
  } finally {
    await second.close();
  }
});

test("project config directory can be redirected or disabled", () => {
  const project = join(home, "project");
  mkdirSync(join(project, ".spec-cli"), { recursive: true });
  writeFileSync(join(project, ".spec-cli", "config.json"), JSON.stringify({ auth: "project" }));

  setProjectDir(project);
  assert.equal(getConfig().auth, "project");

  setProjectDir(null);
  assert.equal(getConfig().auth, null);
  assert.throws(() => writeStore("config", {}), /disabled/);
});

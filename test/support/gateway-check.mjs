import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer, request } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createGatewayServer,
  createGateway,
  directToolName,
  parseSelection,
} from "../../src/gateway.js";
import { gatewayConfig, startGatewayHttp } from "../../src/commands/mcp.js";
import { setLocalPolicyFile } from "../../src/policy.js";
import { fetchSpec } from "../../src/commands/fetch.js";
import { operationSchema, operationQuery } from "../../src/gateway-schema.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";

const root = resolve(import.meta.dirname, "../..");
const closeables = [];
after(async () => {
  for (const item of closeables.reverse()) await item.close();
});
const schema = {
  type: "object",
  properties: { value: { type: "integer" } },
  required: ["value"],
  additionalProperties: false,
};
const mcpSpec = {
  type: "mcp",
  tools: ["echo", "blocked", "fail"].map((name) => ({
    name,
    description: `Tool ${name}`,
    inputSchema: schema,
  })),
};
const requests = [];
const upstream = createServer(async (req, res) => {
  if (req.url === "/mcp") {
    const server = new Server({ name: "fixture", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (request) =>
      request.params?.cursor
        ? { tools: mcpSpec.tools.slice(2) }
        : { tools: mcpSpec.tools.slice(0, 2), nextCursor: "second" }
    );
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => ({
      content: [{ type: "text", text: JSON.stringify(params.arguments) }],
      structuredContent: params.arguments,
      isError: params.name === "fail",
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => void server.close());
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ url: req.url, body, authorization: req.headers.authorization });
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify(
      req.url === "/graphql"
        ? { data: { me: { id: "1", name: "Nir" } } }
        : { url: req.url, body: body ? JSON.parse(body) : null }
    )
  );
});
await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
closeables.push({
  close: () =>
    new Promise((done) => {
      upstream.close(done);
      upstream.closeAllConnections();
    }),
});
const base = `http://127.0.0.1:${upstream.address().port}`;
const graphql = JSON.parse(readFileSync(join(root, "test/fixtures/graphql-spec.json"), "utf8"));
graphql.endpoint = `${base}/graphql`;
const api = {
  type: "openapi",
  servers: [{ url: base }],
  raw: { paths: {} },
  operations: [
    {
      id: "getPet",
      method: "GET",
      path: "/pets/{id}",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "integer" } },
        { name: "tag", in: "query", schema: { type: "string" } },
      ],
    },
  ],
};
const registry = {
  mcp: {
    upstream: { enabled: true, type: "http", url: `${base}/mcp`, disabledTools: ["blocked"] },
    hidden: { enabled: true, type: "http", url: `${base}/mcp` },
    disabled: { enabled: false },
  },
  openapi: { pets: { enabled: true, source: "unused" } },
  graphql: { gql: { enabled: true, source: `${base}/graphql` } },
};
const dependencies = {
  registry: () => registry,
  resolve: async ({ spec }) => ({
    spec: spec === "pets" ? api : spec === "gql" ? graphql : mcpSpec,
  }),
  log: () => {},
};
const config = {
  host: "127.0.0.1",
  port: 0,
  auth: "env:GATEWAY_TEST_TOKEN",
  specs: ["upstream", "pets", "gql"],
};
process.env.GATEWAY_TEST_TOKEN = "gateway-test-only-token";
const gateway = await startGatewayHttp(config, dependencies);
closeables.push(gateway);
const endpoint = `http://127.0.0.1:${gateway.http.address().port}/mcp`;
async function client(query = "", auth = true) {
  const value = new Client({ name: "test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint + query), {
    requestInit: {
      headers: auth ? { Authorization: `Bearer ${process.env.GATEWAY_TEST_TOKEN}` } : {},
    },
  });
  try {
    await value.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }
  closeables.push(value);
  return value;
}
function data(value) {
  return value.structuredContent || JSON.parse(value.content[0].text);
}

test("should validate URL modes and reject malformed filters", () => {
  assert.equal(parseSelection().mode, "meta");
  assert.equal(parseSelection(new URLSearchParams("mode=tools")).mode, "tools");
  for (const query of ["mode=bad", "tools=", "specs=a,,b", "mode=meta&mode=tools", "auth=x"])
    assert.throws(() => parseSelection(new URLSearchParams(query)));
  assert.throws(() => gatewayConfig(["--port", "NaN"]));
});
test("should advertise only five meta-tools and paginate compact discovery", async () => {
  const c = await client();
  assert.deepEqual(
    (await c.listTools()).tools.map((tool) => tool.name),
    ["list_specs", "list_tools", "search_tools", "get_tool", "call_tool"]
  );
  const specs = data(await c.callTool({ name: "list_specs", arguments: { limit: 1 } }));
  assert.equal(specs.items.length, 1);
  assert.equal(specs.total, 3);
  const tools = data(
    await c.callTool({ name: "list_tools", arguments: { spec: "upstream", limit: 1, offset: 1 } })
  );
  assert.equal(tools.total, 2);
  assert.equal(tools.items.length, 1);
  assert.equal(tools.items[0].inputSchema, undefined);
  const search = data(await c.callTool({ name: "search_tools", arguments: { query: "echo" } }));
  assert.equal(search.items[0].id, "upstream.echo");
});
test("should intersect URL filters with server exposure and registry deny rules", async () => {
  const c = await client(
    "?mode=meta&specs=upstream,hidden&tools=upstream.echo,upstream.blocked,hidden.echo"
  );
  const specs = data(await c.callTool({ name: "list_specs", arguments: {} }));
  assert.deepEqual(
    specs.items.map((entry) => entry.name),
    ["upstream"]
  );
  const tools = data(await c.callTool({ name: "list_tools", arguments: { spec: "upstream" } }));
  assert.deepEqual(
    tools.items.map((tool) => tool.id),
    ["upstream.echo"]
  );
  for (const tool of ["upstream.blocked", "hidden.echo", "upstream.fail"]) {
    assert.equal((await c.callTool({ name: "get_tool", arguments: { tool } })).isError, true);
    assert.equal(
      (await c.callTool({ name: "call_tool", arguments: { tool, arguments: { value: 1 } } }))
        .isError,
      true
    );
  }
});
test("should expose raw schemas only on request and validate before execution", async () => {
  const c = await client("?tools=upstream.echo");
  const tool = data(await c.callTool({ name: "get_tool", arguments: { tool: "upstream.echo" } }));
  assert.deepEqual(tool.inputSchema, schema);
  assert.equal(
    (
      await c.callTool({
        name: "call_tool",
        arguments: { tool: tool.id, arguments: { value: "wrong" } },
      })
    ).isError,
    true
  );
  assert.equal(
    (await c.callTool({ name: "call_tool", arguments: { tool: tool.id, arguments: { value: 7 } } }))
      .structuredContent.value,
    7
  );
});
test("should preserve MCP error results and keep serving calls", async () => {
  const c = await client("?specs=upstream");
  assert.equal(
    (
      await c.callTool({
        name: "call_tool",
        arguments: { tool: "upstream.fail", arguments: { value: 1 } },
      })
    ).isError,
    true
  );
  assert.equal((await c.listTools()).tools.length, 5);
});
test("should serve direct tools and isolate simultaneous URL selections", async () => {
  const [direct, meta] = await Promise.all([
    client("?mode=tools&tools=upstream.echo"),
    client("?mode=meta&tools=upstream.fail"),
  ]);
  const tools = (await direct.listTools()).tools;
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, directToolName("upstream.echo"));
  assert.deepEqual(tools[0].inputSchema, schema);
  assert.equal(
    (await direct.callTool({ name: tools[0].name, arguments: { value: 4 } })).structuredContent
      .value,
    4
  );
  assert.equal(
    (await direct.callTool({ name: directToolName("upstream.fail"), arguments: { value: 1 } }))
      .isError,
    true
  );
  assert.equal(
    (
      await meta.callTool({
        name: "call_tool",
        arguments: { tool: "upstream.echo", arguments: { value: 1 } },
      })
    ).isError,
    true
  );
});
test("should call OpenAPI using declared path/query schemas and hide response headers", async () => {
  const c = await client("?mode=tools&specs=pets");
  const tool = (await c.listTools()).tools[0];
  const value = data(
    await c.callTool({ name: tool.name, arguments: { path: { id: 42 }, query: { tag: "a b" } } })
  );
  assert.equal(value.body.url, "/pets/42?tag=a+b");
  assert.equal(value.headers, undefined);
  assert.equal(requests.at(-1).authorization, undefined);
});
test("should generate GraphQL queries and reject arbitrary-query overrides", async () => {
  const c = await client("?tools=gql.me");
  assert.equal(
    data(await c.callTool({ name: "call_tool", arguments: { tool: "gql.me", arguments: {} } })).data
      .me.name,
    "Nir"
  );
  assert.match(JSON.parse(requests.at(-1).body).query, /me/);
  assert.equal(
    (
      await c.callTool({
        name: "call_tool",
        arguments: { tool: "gql.me", arguments: { query: "mutation { createPost }" } },
      })
    ).isError,
    true
  );
});
test("should enforce policy on direct and meta calls", async () => {
  const policy = join(homedir(), "gateway-policy.json");
  writeFileSync(
    policy,
    JSON.stringify([{ id: "deny", spec: "upstream", tool: "echo", when: { value: { eq: 99 } } }])
  );
  setLocalPolicyFile(policy);
  for (const mode of ["meta", "tools"]) {
    const c = await client(`?mode=${mode}&tools=upstream.echo`);
    const call =
      mode === "meta"
        ? { name: "call_tool", arguments: { tool: "upstream.echo", arguments: { value: 99 } } }
        : { name: directToolName("upstream.echo"), arguments: { value: 99 } };
    assert.equal((await c.callTool(call)).isError, true);
  }
});
test("should authenticate every HTTP request and reject hostile origins/hosts", async () => {
  for (const method of ["GET", "POST", "DELETE"])
    assert.equal((await fetch(endpoint, { method })).status, 401);
  const headers = { Authorization: `Bearer ${process.env.GATEWAY_TEST_TOKEN}` };
  assert.equal(
    (await fetch(endpoint, { headers: { ...headers, Origin: "https://evil.example" } })).status,
    403
  );
  const hostileStatus = await new Promise((done, reject) => {
    const req = request(endpoint, { headers: { ...headers, Host: "evil.example" } }, (res) => {
      res.resume();
      done(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostileStatus, 403);
  assert.equal((await fetch(endpoint + "?mode=bad", { headers })).status, 400);
  assert.equal((await fetch(endpoint, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400
  );
});
test("should reject unsafe public binding and empty configured secrets", async () => {
  await assert.rejects(startGatewayHttp({ host: "0.0.0.0", port: 0 }, dependencies));
  process.env.EMPTY_GATEWAY_TOKEN = "";
  await assert.rejects(
    startGatewayHttp({ host: "127.0.0.1", port: 0, auth: "env:EMPTY_GATEWAY_TOKEN" }, dependencies)
  );
});
test("should sanitize upstream exceptions", async () => {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = createGatewayServer({ mode: "meta" }, config, {
    ...dependencies,
    resolve: async () => {
      throw new Error("secret-token C:/private/file");
    },
  });
  const c = new Client({ name: "test", version: "1" });
  await server.connect(serverTransport);
  await c.connect(clientTransport);
  closeables.push(server, c);
  const value = await c.callTool({ name: "list_tools", arguments: { spec: "upstream" } });
  assert.equal(value.isError, true);
  assert.doesNotMatch(JSON.stringify(value), /secret-token|private/);
});
test("should maintain collision-resistant valid MCP names", () => {
  assert.notEqual(directToolName("a.GET /pets"), directToolName("a.GET_/pets"));
  assert.match(directToolName("a.GET /pets/{id}"), /^[a-zA-Z0-9_.-]{1,128}$/);
  assert.ok(directToolName("x".repeat(500)).length <= 128);
});
test("should launch real CLI stdio in both modes against an isolated registry", async () => {
  const directory = join(homedir(), ".spec-cli");
  mkdirSync(directory, { recursive: true });
  const file = join(homedir(), "openapi.json");
  writeFileSync(
    file,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Pets", version: "1" },
      servers: [{ url: base }],
      paths: { "/pets": { get: { operationId: "listPets", responses: {} } } },
    })
  );
  writeFileSync(
    join(directory, "registry.json"),
    JSON.stringify({ mcp: {}, graphql: {}, openapi: { pets: { enabled: true, source: file } } })
  );
  for (const mode of ["meta", "tools"]) {
    const command = process.env.SPEC_GATEWAY_BINARY || process.execPath;
    const args = [
      ...(process.env.SPEC_GATEWAY_BINARY
        ? []
        : [process.env.SPEC_GATEWAY_ENTRY || join(root, "bin/spec.js")]),
      "mcp",
      "--mode",
      mode,
      "--specs",
      "pets",
    ];
    const transport = new StdioClientTransport({
      command,
      args,
      env: { ...process.env },
      cwd: homedir(),
      stderr: "pipe",
    });
    const c = new Client({ name: "stdio-test", version: "1" });
    await c.connect(transport);
    try {
      const tools = (await c.listTools()).tools;
      assert.equal(tools.length, mode === "meta" ? 5 : 1);
      const call =
        mode === "meta"
          ? { name: "call_tool", arguments: { tool: "pets.listPets", arguments: {} } }
          : { name: tools[0].name, arguments: {} };
      assert.equal(data(await c.callTool(call)).body.url, "/pets");
    } finally {
      await c.close();
    }
  }
});
test("should fetch upstream metadata through the existing MCP client", async () => {
  const spec = await fetchSpec({
    _section: "mcp",
    type: "http",
    url: `${base}/mcp`,
    disabledTools: ["blocked"],
  });
  assert.deepEqual(
    spec.tools.map((tool) => tool.name),
    ["echo", "fail"]
  );
});

test("should enforce operator tool allow and deny lists even against cached catalogs", async () => {
  const gateway = createGateway(
    { mode: "meta", tools: ["upstream.echo", "upstream.fail", "hidden.echo"] },
    { tools: ["upstream.echo", "upstream.fail"], disabledTools: ["upstream.fail"] },
    dependencies
  );
  assert.deepEqual(
    (await gateway.catalog()).map((tool) => tool.id),
    ["upstream.echo"]
  );
  assert.deepEqual(
    gateway.entries().map((entry) => entry.name),
    ["upstream"]
  );
  await assert.rejects(gateway.find("upstream.fail"));
});

test("should validate recursive OpenAPI bodies and nullable GraphQL inputs", () => {
  const spec = {
    type: "openapi",
    raw: {
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              value: { type: "integer" },
              child: { $ref: "#/components/schemas/Node" },
            },
            required: ["value"],
          },
        },
      },
    },
  };
  const operation = {
    path: "/nodes",
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } },
    },
  };
  const validate = new AjvJsonSchemaValidator().getValidator(operationSchema(spec, operation));
  assert.equal(validate({ body: { value: 1, child: { value: 2 } } }).valid, true);
  assert.equal(validate({ body: { value: 1, child: { value: "wrong" } } }).valid, false);
  const gqlValidate = new AjvJsonSchemaValidator().getValidator(
    operationSchema(
      graphql,
      graphql.operations.find((operation) => operation.name === "posts")
    )
  );
  assert.equal(gqlValidate({ first: 2, filter: { authorId: null } }).valid, true);
  assert.equal(gqlValidate({ first: null, filter: {} }).valid, false);
});

test("should paginate direct MCP catalogs without losing tool names", async () => {
  const spec = {
    type: "mcp",
    tools: Array.from({ length: 105 }, (_, index) => ({
      name: `tool${index}`,
      inputSchema: { type: "object" },
    })),
  };
  const server = createGatewayServer(
    { mode: "tools" },
    { specs: ["upstream"] },
    { ...dependencies, resolve: async () => ({ spec }) }
  );
  const c = new Client({ name: "pagination", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await c.connect(b);
  closeables.push(server, c);
  const first = await c.listTools();
  assert.equal(first.tools.length, 100);
  const second = await c.listTools({ cursor: first.nextCursor });
  assert.equal(second.tools.length, 5);
  assert.equal(new Set([...first.tools, ...second.tools].map((tool) => tool.name)).size, 105);
});

test("should reject oversized HTTP requests", async () => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GATEWAY_TEST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ data: "x".repeat(110000) }),
  });
  assert.equal(response.status, 413);
});

test("should serialize default array query parameters as repeated keys", () => {
  assert.equal(
    new URLSearchParams(operationQuery(api, api.operations[0], { tag: ["a", "b"] })).toString(),
    "tag=a&tag=b"
  );
  assert.throws(() => operationQuery(api, api.operations[0], { tag: { nested: "value" } }));
});

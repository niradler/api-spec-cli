import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.argv[2];
const capabilities = mode === "resources-only" ? { resources: {} } : { tools: {}, resources: {} };
const server = new Server({ name: "partial", version: "1.0.0" }, { capabilities });

if (mode !== "resources-only") {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "ping", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "pong" }],
  }));
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  if (mode === "broken") throw new Error("backend down");
  return { resources: [{ uri: "notes://today", name: "today" }] };
});

server.setRequestHandler(ReadResourceRequestSchema, async ({ params }) => ({
  contents: [{ uri: params.uri, text: `read:${params.uri}` }],
}));

await server.connect(new StdioServerTransport());

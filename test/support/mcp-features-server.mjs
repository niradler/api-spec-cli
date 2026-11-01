import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "docs", version: "1.0.0" });

server.registerTool("ping", { description: "Ping" }, async () => ({
  content: [{ type: "text", text: "pong" }],
}));

server.registerResource(
  "readme",
  "docs://readme",
  { description: "Project readme", mimeType: "text/markdown" },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Docs" }] })
);

server.registerResource(
  "page",
  new ResourceTemplate("docs://pages/{slug}", { list: undefined }),
  { description: "A docs page", mimeType: "text/plain" },
  async (uri, { slug }) => ({ contents: [{ uri: uri.href, text: `page:${slug}` }] })
);

server.registerPrompt(
  "summarize",
  {
    description: "Summarize a topic",
    argsSchema: { topic: z.string().describe("Topic"), tone: z.string().optional() },
  },
  async ({ topic, tone }) => ({
    description: "Summary prompt",
    messages: [
      {
        role: "user",
        content: { type: "text", text: `Summarize ${topic}${tone ? ` (${tone})` : ""}` },
      },
    ],
  })
);

await server.connect(new StdioServerTransport());

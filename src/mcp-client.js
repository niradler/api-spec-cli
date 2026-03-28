import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function createMcpClient(spec) {
  const client = new Client({ name: "spec-cli", version: "1.0.0" });

  let transport;
  if (spec.transport === "stdio") {
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
    });
  } else if (spec.transport === "sse") {
    transport = new SSEClientTransport(new URL(spec.url));
  } else if (spec.transport === "streamable-http") {
    transport = new StreamableHTTPClientTransport(new URL(spec.url));
  } else {
    throw new Error(`Unknown MCP transport: ${spec.transport}. Supported: stdio, sse, streamable-http`);
  }

  await client.connect(transport);
  return client;
}

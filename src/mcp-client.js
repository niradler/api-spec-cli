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
      env: spec.config?.env ? { ...process.env, ...spec.config.env } : undefined,
    });
  } else if (spec.transport === "sse") {
    const h = spec.config?.headers;
    transport = new SSEClientTransport(new URL(spec.url), {
      requestInit: h && Object.keys(h).length > 0 ? { headers: h } : undefined,
    });
  } else if (spec.transport === "streamable-http") {
    const h = spec.config?.headers;
    transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: h && Object.keys(h).length > 0 ? { headers: h } : undefined,
    });
  } else {
    throw new Error(`Unknown MCP transport: ${spec.transport}. Supported: stdio, sse, streamable-http`);
  }

  await client.connect(transport);
  return client;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MAX_RETRIES = parseInt(process.env.MCP_MAX_RETRIES ?? "3");
const RETRY_DELAY = parseInt(process.env.MCP_RETRY_DELAY ?? "1000");

// Expand ${VAR} placeholders from process.env at call time
function expandEnv(val) {
  return val.replace(/\$\{([^}]+)\}/g, (_, name) => {
    if (!(name in process.env)) throw new Error(`Environment variable not set: ${name}`);
    return process.env[name];
  });
}

async function connect(spec) {
  const client = new Client({ name: "spec-cli", version: "1.0.0" });

  let transport;
  if (spec.transport === "stdio") {
    const rawEnv = spec.config?.env || {};
    const expandedEnv = Object.fromEntries(
      Object.entries(rawEnv).map(([k, v]) => [k, expandEnv(v)])
    );
    transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: Object.keys(expandedEnv).length > 0 ? { ...process.env, ...expandedEnv } : undefined,
      cwd: spec.cwd,
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

export async function createMcpClient(spec) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await connect(spec);
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, Math.min(RETRY_DELAY * Math.pow(2, attempt), 5000)));
      }
    }
  }
  throw lastError;
}

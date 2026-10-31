import type { AddressInfo } from "node:net";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseArgs } from "../args.ts";
import { createGatewayServer } from "../gateway.ts";
import { gatewayConfig, gatewayLogger, startGatewayHttp } from "../gateway-http.ts";
import { closeMcpClients } from "../mcp-client.ts";

export async function mcpCmd(args: string[]): Promise<void> {
  const config = gatewayConfig(parseArgs(args).flags);
  const log = gatewayLogger(config);
  let close: () => Promise<void>;
  if (config.transport === "http") {
    const gateway = await startGatewayHttp(config, { log });
    close = gateway.close;
    const { port } = gateway.http.address() as AddressInfo;
    process.stderr.write(`spec MCP listening at http://${config.host}:${port}/mcp\n`);
  } else {
    const server = createGatewayServer({ mode: config.mode }, config);
    await server.connect(new StdioServerTransport());
    close = async () => {
      await server.close();
      await closeMcpClients();
      log("stopped");
    };
    log("started", { transport: "stdio", mode: config.mode });
    process.stdin.once("end", () => void shutdown());
  }
  let stopping = false;
  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    await close();
    clearTimeout(timer);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

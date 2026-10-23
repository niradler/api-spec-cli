import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { parseArgs } from "../args.js";
import { createGatewayServer, parseSelection } from "../gateway.js";
import { closeMcpClients } from "../mcp-client.js";
import { GLOBAL_DIR } from "../paths.js";
import { expandSecrets } from "../secrets.js";

const strings = {
  type: "array",
  maxItems: 100,
  items: { type: "string", minLength: 1, maxLength: 256 },
};
const configSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    transport: { enum: ["stdio", "http"] },
    mode: { enum: ["meta", "tools"] },
    host: { type: "string", minLength: 1 },
    port: { type: "integer", minimum: 0, maximum: 65535 },
    specs: strings,
    tools: strings,
    disabledTools: strings,
    allowedHosts: strings,
    allowedOrigins: strings,
    auth: { type: "string", minLength: 1 },
    logFile: { type: "string", minLength: 1 },
  },
};

export function gatewayConfig(args) {
  const { flags } = parseArgs(args);
  const file = flags.config ? JSON.parse(readFileSync(flags.config, "utf8")) : {};
  if (!file || typeof file !== "object" || Array.isArray(file))
    throw new Error("Gateway config must be an object");
  const config = { transport: "stdio", mode: "meta", host: "127.0.0.1", port: 3000, ...file };
  for (const key of ["transport", "mode", "host", "auth"])
    if (flags[key] !== undefined) config[key] = flags[key];
  if (flags.port !== undefined) config.port = Number(flags.port);
  for (const key of ["specs", "tools"])
    if (flags[key] !== undefined)
      config[key] = String(flags[key])
        .split(",")
        .map((value) => value.trim());
  const validation = new AjvJsonSchemaValidator().getValidator(configSchema)(config);
  if (!validation.valid)
    throw new Error(`Invalid gateway configuration: ${validation.errorMessage}`);
  return config;
}

function logger(config) {
  const path = config.logFile || join(GLOBAL_DIR, "logs", "mcp.log");
  mkdirSync(dirname(path), { recursive: true });
  return (event, data = {}) =>
    appendFileSync(
      path,
      JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n",
      { mode: 0o600 }
    );
}

export async function startGatewayHttp(config, dependencies = {}) {
  const log = dependencies.log || logger(config);
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(config.host);
  if (!loopback && (!config.auth || !config.allowedHosts?.length))
    throw new Error("Non-loopback HTTP requires auth and allowedHosts");
  const secret = config.auth ? expandSecrets(config.auth) : undefined;
  if (config.auth && (!secret || /\s/.test(secret)))
    throw new Error("Gateway auth must resolve to a non-empty bearer token without whitespace");
  const expectedToken = secret && createHash("sha256").update(secret).digest();
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use((req, res, next) => {
    res.setHeader("X-Request-Id", randomUUID());
    res.setHeader("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins?.includes(origin))
      return res.status(403).json({ error: "Forbidden", requestId: res.getHeader("X-Request-Id") });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, MCP-Protocol-Version"
      );
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  app.use(
    rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false })
  );
  if (secret)
    app.use(
      requireBearerAuth({
        verifier: {
          async verifyAccessToken(token) {
            if (!timingSafeEqual(createHash("sha256").update(token).digest(), expectedToken))
              throw new InvalidTokenError("Invalid token");
            return { token, clientId: "gateway", scopes: [], expiresAt: Number.MAX_SAFE_INTEGER };
          },
        },
      })
    );
  app.use(createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts }));
  const active = new Set();
  let draining = false;
  app.all("/mcp", async (req, res) => {
    let server;
    let transport;
    try {
      const url = new URL(req.originalUrl, "http://gateway.local");
      const selection = parseSelection(url.searchParams);
      if (draining || active.size >= 100) return res.status(503).json({ error: "Unavailable" });
      server = createGatewayServer(selection, config, dependencies);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      active.add(server);
      res.on("close", () => {
        active.delete(server);
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log("request_failed", {
        requestId: res.getHeader("X-Request-Id"),
        category: server ? "upstream" : "configuration",
      });
      if (!res.headersSent)
        res.status(server ? 500 : 400).json({
          error: server ? "Gateway request failed" : "Invalid gateway parameters",
          requestId: res.getHeader("X-Request-Id"),
        });
      if (server) {
        active.delete(server);
        await server.close();
      }
    }
  });
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res
      .status(error.status === 413 ? 413 : 400)
      .json({ error: "Invalid request", requestId: res.getHeader("X-Request-Id") });
  });
  const http = await new Promise((resolve, reject) => {
    const listener = app.listen(config.port, config.host, () => resolve(listener));
    listener.once("error", reject);
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 15_000;
  log("started", {
    transport: "http",
    host: config.host,
    port: http.address().port,
    authenticated: Boolean(secret),
  });
  return {
    http,
    async close() {
      draining = true;
      const closed = new Promise((resolve) => http.close(resolve));
      await Promise.allSettled([...active].map((server) => server.close()));
      await closeMcpClients();
      http.closeAllConnections();
      await closed;
      log("stopped");
    },
  };
}

export async function mcpCmd(args) {
  const config = gatewayConfig(args);
  const log = logger(config);
  let close;
  if (config.transport === "http") {
    const gateway = await startGatewayHttp(config, { log });
    close = gateway.close;
    process.stderr.write(
      `spec MCP listening at http://${config.host}:${gateway.http.address().port}/mcp\n`
    );
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
  async function shutdown() {
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

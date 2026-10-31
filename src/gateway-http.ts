import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { flagString, type Flags } from "./args.ts";
import {
  createGatewayServer,
  parseSelection,
  type GatewayDependencies,
  type GatewayMode,
} from "./gateway.ts";
import { createMcpSession } from "./mcp-client.ts";
import { specHome } from "./paths.ts";
import { expandSecrets } from "./secrets.ts";

export interface GatewayConfig {
  transport: "stdio" | "http";
  mode: GatewayMode;
  host: string;
  port: number;
  specs?: string[];
  tools?: string[];
  disabledTools?: string[];
  allowedHosts?: string[];
  allowedOrigins?: string[];
  auth?: string;
  logFile?: string;
}

export type GatewayLogger = (event: string, data?: Record<string, unknown>) => void;

export interface GatewayHttpDependencies extends GatewayDependencies {
  log?: GatewayLogger;
}

export interface GatewayHttp {
  http: HttpServer;
  close(): Promise<void>;
}

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

export function gatewayConfig(flags: Flags): GatewayConfig {
  const configFile = flagString(flags, "config");
  const file: unknown = configFile ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  if (!file || typeof file !== "object" || Array.isArray(file))
    throw new Error("Gateway config must be an object");
  const config: Record<string, unknown> = {
    transport: "stdio",
    mode: "meta",
    host: "127.0.0.1",
    port: 3000,
    ...file,
  };
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
  return config as unknown as GatewayConfig;
}

export function gatewayLogger(config: Pick<GatewayConfig, "logFile">): GatewayLogger {
  const path = config.logFile || join(specHome(), "logs", "mcp.log");
  mkdirSync(dirname(path), { recursive: true });
  return (event, data = {}) =>
    appendFileSync(
      path,
      JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...data }) + "\n",
      { mode: 0o600 }
    );
}

export async function startGatewayHttp(
  config: GatewayConfig,
  dependencies: GatewayHttpDependencies = {}
): Promise<GatewayHttp> {
  const log = dependencies.log || gatewayLogger(config);
  const session = dependencies.session ?? createMcpSession();
  const gatewayDependencies = { ...dependencies, session };
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(config.host);
  if (!loopback && (!config.auth || !config.allowedHosts?.length))
    throw new Error("Non-loopback HTTP requires auth and allowedHosts");
  const secret = config.auth ? expandSecrets(config.auth) : undefined;
  if (config.auth && (!secret || /\s/.test(secret)))
    throw new Error("Gateway auth must resolve to a non-empty bearer token without whitespace");
  const expectedToken = secret ? createHash("sha256").update(secret).digest() : undefined;
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
            if (!timingSafeEqual(createHash("sha256").update(token).digest(), expectedToken!))
              throw new InvalidTokenError("Invalid token");
            return { token, clientId: "gateway", scopes: [], expiresAt: Number.MAX_SAFE_INTEGER };
          },
        },
      })
    );
  app.use(createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts }));
  const active = new Set<Server>();
  let draining = false;
  app.all("/mcp", async (req, res) => {
    let server: Server | undefined;
    let transport: StreamableHTTPServerTransport;
    try {
      const url = new URL(req.originalUrl, "http://gateway.local");
      const selection = parseSelection(url.searchParams);
      if (draining || active.size >= 100) return res.status(503).json({ error: "Unavailable" });
      server = createGatewayServer(selection, config, gatewayDependencies);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      active.add(server);
      const current = server;
      res.on("close", () => {
        active.delete(current);
        void current.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
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
  app.use((error: { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    res
      .status(error.status === 413 ? 413 : 400)
      .json({ error: "Invalid request", requestId: res.getHeader("X-Request-Id") });
  });
  const http = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(config.port, config.host, () => resolve(listener));
    listener.once("error", reject);
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 15_000;
  log("started", {
    transport: "http",
    host: config.host,
    port: (http.address() as AddressInfo).port,
    authenticated: Boolean(secret),
  });
  return {
    http,
    async close() {
      draining = true;
      const closed = new Promise((resolve) => http.close(resolve));
      await Promise.allSettled([...active].map((server) => server.close()));
      if (!dependencies.session) await session.close();
      http.closeAllConnections();
      await closed;
      log("stopped");
    },
  };
}

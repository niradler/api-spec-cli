// A Bearer-protected MCP server with its own OAuth 2.1 authorization server: protected-resource
// metadata, dynamic client registration, an auto-approving /authorize, and a /token endpoint
// that enforces PKCE (S256) for public clients.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const s256 = (verifier) => createHash("sha256").update(verifier).digest("base64url");

export async function startOAuthMcpServer() {
  const registrations = [];
  const tokenRequests = [];
  const codes = new Map();
  const accessTokens = new Set();
  let base = "";

  const json = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    return body;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.pathname === "/register" && req.method === "POST") {
      const metadata = JSON.parse(await readBody(req));
      const client = { ...metadata, client_id: `client-${registrations.length + 1}` };
      registrations.push(client);
      return json(res, 201, client);
    }
    if (url.pathname === "/authorize") {
      const params = Object.fromEntries(url.searchParams);
      const client = registrations.find((item) => item.client_id === params.client_id);
      if (!client?.redirect_uris?.includes(params.redirect_uri))
        return json(res, 400, { error: "invalid_redirect_uri" });
      if (params.code_challenge_method !== "S256" || !params.code_challenge)
        return json(res, 400, { error: "invalid_request" });
      const code = randomUUID();
      codes.set(code, params);
      const target = new URL(params.redirect_uri);
      target.searchParams.set("code", code);
      if (params.state) target.searchParams.set("state", params.state);
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      const body = Object.fromEntries(new URLSearchParams(await readBody(req)));
      tokenRequests.push({ body, authorization: req.headers.authorization });
      const issued = codes.get(body.code);
      codes.delete(body.code);
      if (
        body.grant_type !== "authorization_code" ||
        !issued ||
        body.client_id !== issued.client_id ||
        body.redirect_uri !== issued.redirect_uri ||
        s256(body.code_verifier ?? "") !== issued.code_challenge
      )
        return json(res, 400, { error: "invalid_grant" });
      const accessToken = randomUUID();
      accessTokens.add(accessToken);
      return json(res, 200, { access_token: accessToken, token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (!token || !accessTokens.has(token)) {
        res.writeHead(401, {
          "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        });
        return res.end();
      }
      const mcp = new Server({ name: "secure", version: "1" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "whoami", description: "Who am I", inputSchema: { type: "object" } }],
      }));
      mcp.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: "text", text: "authorized" }],
      }));
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => void mcp.close());
      await mcp.connect(transport);
      return transport.handleRequest(req, res);
    }
    json(res, 404, { error: "not_found" });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/mcp`,
    registrations,
    tokenRequests,
    close: () =>
      new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      }),
  };
}

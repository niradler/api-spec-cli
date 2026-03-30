# MCP OAuth 2.1 Authorization — Design

**Date:** 2026-03-30
**Status:** Approved

---

## Overview

Add OAuth 2.1 authorization support to spec-cli for MCP HTTP/SSE servers. The MCP spec mandates OAuth 2.1 with PKCE for HTTP-based transports. spec-cli auto-detects when a server requires OAuth (via `401 + WWW-Authenticate`) and handles the full flow transparently — just like VS Code and Claude Desktop do.

---

## Goals

- Auto-detect OAuth on any MCP HTTP/SSE connection — no extra flags needed for the happy path
- Support three grant types: authorization code + PKCE (browser), device flow (headless/SSH), client credentials (machine-to-machine)
- Persist tokens, client registration, and discovery state per spec entry
- Proactive token refresh (before expiry) + reactive refresh (on 401)
- Align registry schema with `mcp.json` format (VS Code/Claude Desktop)
- Use the MCP SDK's built-in OAuth primitives correctly — no reinventing the wheel

---

## Registry Schema Changes

MCP entries are restructured to match `mcp.json` format. OpenAPI/GraphQL entries are unchanged.

### MCP entries (new — flat, mcp.json compatible)

```json
{
  "name": "github",
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": { "X-Custom": "value" },
  "allowedTools": ["get*"],
  "disabledTools": [],
  "description": "GitHub Copilot MCP",
  "enabled": true
}
```

```json
{
  "name": "fs",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  "env": { "TOKEN": "${MY_SECRET}" },
  "enabled": true
}
```

**Type values:** `"http"` (streamable HTTP), `"sse"`, `"stdio"` — replaces old `type:"mcp" + transport` fields.

### OpenAPI/GraphQL entries (unchanged)

```json
{
  "name": "petstore",
  "type": "openapi",
  "source": "https://...",
  "config": { "baseUrl": "...", "auth": "...", "headers": {}, "allowedTools": [] },
  "enabled": true
}
```

**Migration:** Manual — update `~/spec-cli-config/registry.json` directly (single user).

**Helper added to `registry.js`:**
```js
export function isMcp(entry) {
  return entry.type === "http" || entry.type === "sse" || entry.type === "stdio";
}
```

---

## Token Storage

**Location:** `~/spec-cli-config/tokens/<name>.json`

Separate from cache (cache is disposable; tokens are credentials). `spec refresh` does not touch tokens.

**Shape:**
```json
{
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "def502...",
    "expires_in": 3600
  },
  "clientInfo": {
    "client_id": "abc123",
    "client_secret": "optional-for-dcr"
  },
  "discovery": {
    "authorizationServerUrl": "https://auth.example.com",
    "resourceMetadata": { "scopes_supported": ["mcp:tools"] }
  }
}
```

All three sections are written to the same file — one read/write per operation, no separate files.

---

## New Files

### `src/oauth/provider.js` — `SpecCliOAuthProvider`

Implements `OAuthClientProvider` from `@modelcontextprotocol/sdk/client/auth.js`. Modelled on the SDK's `InMemoryOAuthClientProvider` example, with file-based persistence.

| Method | Behavior |
|---|---|
| `tokens()` | Read `tokens/<name>.json` → `.tokens` |
| `saveTokens(t)` | Write `.tokens` field |
| `clientInformation()` | Read `.clientInfo` field |
| `saveClientInformation(i)` | Write `.clientInfo` field |
| `discoveryState()` | Read `.discovery` field |
| `saveDiscoveryState(s)` | Write `.discovery` field |
| `saveCodeVerifier(v)` | In-memory (lives only during PKCE handshake) |
| `codeVerifier()` | In-memory |
| `redirectToAuthorization(url)` | Default: open browser + local HTTP callback server. Device flow: print URL + code to stderr, poll token endpoint. |

The `redirectUrl` for PKCE is `http://localhost:<random-port>/callback`. A temporary HTTP server listens for the redirect, extracts the `code`, then calls `transport.finishAuth(code)`.

### `src/oauth/tokens.js` — Token file helpers

```js
loadTokenFile(name)     // read full file or {}
saveTokenFile(name, data) // write full file
clearTokenFile(name)    // delete file
```

Used by `SpecCliOAuthProvider` and the `spec auth` command.

### `src/commands/auth.js` — `spec auth` command

```bash
spec auth <name>           # re-run OAuth flow for existing spec
spec auth <name> --revoke  # clear stored token only
```

Re-auth triggers the same provider flow as `spec add`. Useful when refresh token is expired or revoked.

---

## Changes to Existing Files

### `src/mcp-client.js`

For `http`/`sse` entries, pass `authProvider` to the transport — the SDK handles 401, token injection, and retry:

```js
import { SpecCliOAuthProvider } from "./oauth/provider.js";
import { ClientCredentialsProvider } from "@modelcontextprotocol/sdk/client/auth-extensions.js";

// Browser / device flow
transport = new StreamableHTTPClientTransport(new URL(spec.url), {
  authProvider: new SpecCliOAuthProvider(spec.name, spec),
});

// Machine flow (--oauth-client-id + --oauth-client-secret)
transport = new StreamableHTTPClientTransport(new URL(spec.url), {
  authProvider: new ClientCredentialsProvider({
    clientId: spec.oauthClientId,
    clientSecret: spec.oauthClientSecret,
  }),
});
```

No manual 401 handling or token injection — the transport owns that entirely.

### `src/commands/add.js`

After saving the registry entry, if the spec is `type: "http"` or `"sse"`:
1. Attempt connection to probe for OAuth requirement
2. If `UnauthorizedError` is thrown → run `auth()` from the SDK (discovery → DCR → token flow)
3. Block until flow completes — tokens saved to `tokens/<name>.json`
4. Print confirmation

CLI flags for OAuth overrides:
```bash
spec add myserver --mcp-http https://...              # auto-detect (default)
spec add myserver --mcp-http https://... --oauth-flow device  # force device flow
spec add myserver --mcp-http https://... \
  --oauth-client-id <id> --oauth-client-secret <secret>  # machine flow
```

### `src/registry.js`

- Add `isMcp(entry)` helper
- Update `getEntry()` to read flat MCP fields (`entry.headers`, `entry.type`) instead of `entry.config.headers`, `entry.transport`

---

## Grant Type Selection

| Condition | Flow |
|---|---|
| `--oauth-client-id` + `--oauth-client-secret` present | Client credentials (SDK's `ClientCredentialsProvider`) |
| `--oauth-flow device` | Device authorization grant (custom provider subclass) |
| Default | Authorization code + PKCE (browser + local callback server) |

---

## Token Refresh

- **Proactive:** Before connecting, if `tokens.expires_in` indicates expiry within 60s and `refresh_token` exists → refresh via SDK's `refreshAuthorization()`
- **Reactive:** Transport handles 401 natively when `authProvider` is set — retries once after refresh
- **No refresh token:** Skip proactive check; transport handles 401 with re-auth prompt
- **Re-auth hint:** If auth fails after refresh → `"Auth failed for '<name>' — run: spec auth <name>"`

---

## Future Improvement

`spec import <file>` — bulk import from VS Code `mcp.json` or Claude Desktop config format. Not in scope for this implementation.

---

## CLI Summary

```bash
# Auto-detect OAuth (no flags needed for compliant servers)
spec add github --mcp-http https://api.githubcopilot.com/mcp/

# Force device flow (SSH/headless)
spec add github --mcp-http https://... --oauth-flow device

# Machine/CI flow
spec add github --mcp-http https://... \
  --oauth-client-id <id> --oauth-client-secret <secret>

# Re-authenticate
spec auth github

# Revoke stored token
spec auth github --revoke
```

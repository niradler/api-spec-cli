# api-spec-cli

CLI for AI agents to explore and call OpenAPI, GraphQL, and MCP APIs. Output is TOON by default — compact, parseable, token-efficient.

## Install

```bash
npm install -g api-spec-cli
```

Works with Node.js 18+. No other dependencies.

```bash
# Or run without installing
npx api-spec-cli <command>
```

## How It Works

Every command is stateless — you specify the spec source on each call. Two paths:

| Path | When to use |
|---|---|
| `--spec <name>` | Registered spec — auto-fetches and caches on first use |
| Inline flags | Ad-hoc — no registration, fetched each call |

### Register once, use everywhere

```bash
spec add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json \
  --base-url https://petstore3.swagger.io/api/v3 \
  --description "Petstore example"

spec add hashnode --graphql https://gql.hashnode.com --auth YOUR_TOKEN

spec add agno --mcp-http https://docs.agno.com/mcp --description "Agno docs"

spec add fs --mcp-stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"

spec import ~/.cursor/mcp.json
spec import ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Registration is instant — does not connect. Connection happens on first `list`/`show`/`call` and the result is cached at `~/spec-cli-config/cache/<name>.json`.

### Or use inline (no registration)

```bash
spec list --openapi https://petstore3.swagger.io/api/v3/openapi.json
spec list --graphql https://gql.hashnode.com
spec list --mcp-http https://docs.agno.com/mcp
spec list --mcp-sse http://localhost:3000/sse
spec list --mcp-stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

Inline fetches every call, nothing cached.

---

## Discovery

### Search across specs

`grep` searches operation/tool names and descriptions across all registered specs.

```bash
spec grep search                        # Substring match across all specs
spec grep "get*"                        # Glob: anything starting with "get"
spec grep "*list*"                      # Glob: anything containing "list"
spec grep search --spec agno            # Limit to one spec
```

Matches on name and description. Case-insensitive. Plain text = substring, `*`/`?` = glob.

### List all specs in the registry

```bash
spec specs                    # Compact: name, type, enabled
spec specs --compact false    # Full: includes source, config
```

### List operations / tools

`list` is compact (IDs only) and returns the first **20** tools/operations by default. `total` is the full catalog size. Use `--filter`, `spec grep`, `--limit`, and `--offset` on large MCP servers instead of dumping hundreds of tools. `--limit 0` prints the whole catalog.

```bash
spec list --spec agno                          # Registered spec (uses cache)
spec list --spec petstore --filter pet         # Search by keyword
spec list --spec petstore --tag pets           # OpenAPI: filter by tag
spec list --spec hashnode --tag mutation        # GraphQL: filter by kind
spec list --spec petstore --limit 10           # First 10 only
spec list --spec petstore --limit 10 --offset 10  # Next 10
spec list --spec datadog --limit 0             # All tools (prefer grep on large servers)
spec list --mcp-http https://docs.agno.com/mcp # Inline: no registration needed
spec specs --filter datadog                    # Find a registered server by name
spec grep metric --spec datadog                # Search 300+ MCP tools without dumping them
spec grep metric --spec datadog --limit 10 --offset 10
```

Compact output (`--format json` shown for readability):
```json
{
  "type": "mcp",
  "total": 1,
  "showing": 1,
  "operations": [
    { "id": "search_agno", "description": "Search across the Agno knowledge base..." }
  ]
}
```

Use `--compact false` for full details including `inputSchema` for MCP tools.

### Inspect one operation or tool

`show` gives you everything to make a call — params, body schema, response schemas, related types — in one call.

```bash
spec show --spec petstore getPetById           # OpenAPI: by operationId
spec show --spec petstore /pet/{petId}         # OpenAPI: by path
spec show --spec petstore "GET /pet/{petId}"   # OpenAPI: by method + path
spec show --spec hashnode publishPost          # GraphQL: by operation name
spec show --spec agno search_agno             # MCP: by tool name
```

MCP output includes the full `inputSchema` so you know exactly what arguments to pass.

### Drill into types (OpenAPI/GraphQL only)

```bash
spec types --spec petstore                     # List all schema names
spec types --spec petstore Pet                 # Inspect one schema
spec types --spec hashnode PublishPostInput    # GraphQL input type
```

---

## Calling APIs

```bash
# OpenAPI
spec call --spec petstore getPetById --var petId=1
spec call --spec petstore findPetsByStatus --query status=available
spec call --spec petstore addPet --data '{"name":"Rex","photoUrls":[]}'

# GraphQL (auto-generates query from schema)
spec call --spec hashnode me
spec call --spec hashnode publication --var host=blog.hashnode.dev

# MCP
spec call --spec agno search_agno --var query="how to create an agent"
spec call --spec agno search_agno --data '{"query":"agents"}'

# Read body from stdin (explicit --data -)
echo '{"query":"agents"}' | spec call --spec agno search_agno --data -
cat body.json | spec call --spec petstore addPet --data -

# Inline (no registration)
spec call --openapi https://petstore3.swagger.io/api/v3/openapi.json \
  getPetById --var petId=1 --base-url https://petstore3.swagger.io/api/v3
```

### Per-call overrides

Flags passed at call time win over registry entry config, which wins over `.spec-cli/config.json`.

```bash
spec call --spec agno search_agno --var query="foo" --header X-Tenant=acme
spec call --spec petstore getPetById --var petId=1 --auth staging-token
spec list --spec petstore --base-url https://staging.api.example.com
```

---

## Registry Management

```bash
spec remove <name>    # Delete entry and remove cache
spec enable <name>    # Re-enable a disabled spec
spec disable <name>   # Disable without removing
spec refresh <name>   # Force re-fetch and update cache
```

`spec add` is an upsert — re-adding an existing name overwrites the entry (and clears its stale cache), since there's no separate `update` command. The response includes `"overwritten": true` when an existing entry was replaced.

## Usage Ranking

`spec` records which operations/tools you call so agents can surface the ones that matter:

```bash
spec list --spec petstore --top 5   # the 5 most-called operations first
spec usage                          # recorded usage across all specs
spec usage petstore                 # ranked operations for one spec
```

Counts are stored locally in `~/spec-cli-config/usage.json`. `--top` applies after `--filter`/`--tag` and overrides `--limit`. Set `SPEC_NO_USAGE=1` to disable tracking.

## Secrets & Environment Overrides

Stored values can reference secrets without putting them in argv or the registry. All of these expand at call time:

- `${VAR}` from the environment
- `env:NAME` — same as mcp2cli, the whole value is an env var
- `file:/path/to/secret` — file contents (trailing newline stripped)

```bash
spec add gh --mcp-http https://api.example.com/mcp --header "Authorization=Bearer ${GH_TOKEN}"
spec add gh --mcp-http https://api.example.com/mcp --auth env:GH_TOKEN
spec add gh --mcp-http https://api.example.com/mcp --oauth-client-secret file:/run/secrets/oauth
spec config set auth '${API_TOKEN}'
```

A `.env` file in the working directory is auto-loaded on startup (real environment variables take precedence; set `SPEC_NO_DOTENV=1` to disable).

Two environment variables override a registered spec's connection per call — useful in CI:

```bash
SPEC_URL=https://staging.example.com/mcp spec call --spec gh some_tool   # override MCP/GraphQL endpoint
SPEC_HEADER_X_TENANT=acme spec list --spec gh                            # add/override a header
```

`SPEC_HEADER_<NAME>` maps underscores to dashes (`SPEC_HEADER_X_TENANT` → `X-Tenant`). Precedence: call-time flags > env override > registry entry > project config.

## Agent Skill

Install a ready-made skill that teaches an agent the explore-then-call workflow:

```bash
spec skill install   # copy SKILL.md into ~/.claude/skills/api-spec-cli/
spec skill path      # print the bundled SKILL.md location
```

---

## spec add options

```bash
spec add <name> --openapi <url-or-file>   [--base-url <url>] [--auth <token>] [--header k=v]
spec add <name> --graphql <url>            [--auth <token>] [--header k=v]
spec add <name> --mcp-http <url>           [--auth <token>] [--header k=v]
spec add <name> --mcp-sse <url>            [--auth <token>] [--header k=v]
spec add <name> --mcp-stdio "<cmd args>"   [--env KEY=VAL] [--cwd <path>]
                                           [--description <text>]  (all types)
```

All options are repeatable where it makes sense (`--header`, `--env`). `--auth` adds `Authorization: Bearer <token>` unless the header is already set.

Operation filtering works for all spec types — MCP, OpenAPI, and GraphQL:

```bash
# MCP: allow only read/list tools
spec add <name> --mcp-http <url> \
  --allow-tool "read_*" --allow-tool "list_*" \
  --disable-tool "delete_*"

# OpenAPI: allow only GET operations (by operationId)
spec add <name> --openapi <url> \
  --allow-tool "get*" --allow-tool "find*"

# GraphQL: allow specific operations by exact name
spec add <name> --graphql <url> \
  --allow-tool "me" --allow-tool "publication"
```

`--allow-tool` keeps only matching operations. `--disable-tool` removes matching operations (applied after allow). Both are repeatable.

**Matching rules:**
- Plain text → **exact match** (case-insensitive): `"me"` matches only `me`
- Glob patterns → anchored match: `"get*"` matches `getPetById`, `"*post*"` matches `createPost`

Use `grep` for search (substring) — `--allow-tool` / `--disable-tool` for precise whitelists (exact or glob).

---

## OAuth / Authentication

MCP HTTP and SSE servers that require OAuth 2.1 are handled automatically. spec-cli detects the 401 on `spec add` and runs the flow before returning.

Two modes depending on whether the server supports Dynamic Client Registration (DCR):

- **DCR-enabled servers** (e.g. self-hosted with Cloudflare workers-oauth-provider, Stytch, Curity) — no flags needed, browser opens automatically
- **Pre-registered-only servers** (e.g. GitHub) — pass `--oauth-client-id` with your app's client ID

### Interactive (browser) — default

```bash
# DCR-enabled server: fully automatic
spec add myserver --mcp-http https://...

# GitHub (no DCR) — create an OAuth App at github.com/settings/developers first
# Set callback URL to http://127.0.0.1:8090/callback
spec add github --mcp-http https://api.githubcopilot.com/mcp/ \
  --oauth-client-id <your-github-app-client-id> \
  --oauth-callback-port 8090
```

### Headless / device flow

```bash
spec add myserver --mcp-http https://... --oauth-flow device
# Prints a URL to stderr — open in any browser to authorize
```

### Machine / CI (client credentials)

```bash
spec add myserver --mcp-http https://... \
  --oauth-flow client_credentials \
  --oauth-client-id <id> --oauth-client-secret <secret>
```

### Re-authenticate

```bash
spec auth myserver           # Re-run the OAuth flow
spec auth myserver --revoke  # Clear stored token only
```

Tokens are stored in `~/spec-cli-config/tokens/<name>.json` — separate from the cache, not touched by `spec refresh`. Access tokens are refreshed automatically: when a stored token expires, the refresh token is used and the rotated tokens are persisted, so the next command picks them up without re-authenticating.

### OAuth flags

| Flag | Description |
| --- | --- |
| `--oauth-client-id <id>` | Skip DCR — use a pre-registered OAuth app client ID |
| `--oauth-client-secret <secret>` | Use client credentials flow (machine/CI) |
| `--oauth-callback-port <port>` | Fixed callback port (required for apps with exact redirect URL match, e.g. GitHub) |
| `--oauth-flow device` | Force device authorization flow (headless/SSH) |
| `--oauth-flow client_credentials` | Machine/CI flow (requires client id + secret) |

Reuse a stored MCP OAuth access token on an OpenAPI or GraphQL call (only if the token audience matches):

```bash
spec call --spec petstore getPet --auth-from github-mcp
```

---

## Config

Persistent config stored in `.spec-cli/config.json` (lowest priority — overridden by registry entry config and call-time flags).

```bash
spec config set baseUrl https://api.example.com
spec config set auth my-token                        # Auto-adds "Bearer " prefix
spec config set auth "Basic dXNlcjpwYXNz"            # Or explicit scheme
spec config set headers.X-API-Key abc123              # Custom header (dot notation)
spec config get
spec config unset auth
```

## Validate

```bash
spec validate https://api.example.com/openapi.json
spec validate ./openapi.yaml
```

Reports broken `$ref` references, missing required fields, duplicate operationIds, invalid schema types, and more.

## Output Format

TOON by default. Errors go to stderr as plain text (`error: ...`) with a non-zero exit code.

```bash
spec list --spec petstore                      # TOON (default)
spec list --spec petstore --format json        # pretty-printed JSON
spec show --spec petstore getPetById --format yaml
spec list --spec petstore --format text
```

`toon` ([Token-Oriented Object Notation](https://github.com/toon-format/spec)) is the most token-efficient format for tabular/list output — the best choice when feeding results back into a model. Pass `--format json` for pretty-printed JSON. Help and errors are always plain text.

If formatted stdout is over **30000** characters (same ballpark as agent harness tool-result limits), `spec` writes the full payload as JSON to `~/spec-cli-config/results/` and prints a stub with `path` so you can `rg` / read chunks instead of swallowing the blob. Override with `--max-bytes` or `SPEC_MAX_STDOUT`. `--max-bytes 0` always prints.

```
cached: true
path: C:\Users\you\spec-cli-config\results\2026-08-30T22-16-03-123.json
bytes: 184320
hint: rg <pattern> <path>
```

## Token Efficiency

- `list` returns only IDs by default — no schemas
- `show` resolves `$ref` compactly — nested refs show as names, not explosions
- `types` lets you inspect one schema at a time
- `--limit` / `--offset` paginate large APIs (list/grep default to 20)
- Oversized `call`/`show`/`list` output spills to `~/spec-cli-config/results/` instead of flooding context
- `--filter` and `--tag` narrow results before output

## MCP Options

```bash
# Retry on connection failure (useful for stdio servers that take time to start)
MCP_MAX_RETRIES=3       # Attempts (default: 3)
MCP_RETRY_DELAY=1000    # Base delay in ms, doubles each attempt, capped at 5s (default: 1000)

# HTTP timeout for OpenAPI/GraphQL calls
SPEC_HTTP_TIMEOUT=30000 # ms (default: 30000)
```

Stdio env vars support `${VAR}` expansion from the host environment:

```bash
spec add fs --mcp-stdio "npx -y server /tmp" --env "TOKEN=${MY_SECRET}"
```

## Storage

| Path | Purpose |
|---|---|
| `~/spec-cli-config/registry.json` | Global named registry |
| `~/spec-cli-config/cache/<name>.json` | Cached spec per registered entry |
| `~/spec-cli-config/tokens/<name>.json` | OAuth tokens per MCP entry |
| `~/spec-cli-config/usage.json` | Operation/tool call counts for `--top` and `spec usage` |
| `~/spec-cli-config/results/` | Full JSON for stdout that exceeded `SPEC_MAX_STDOUT` |
| `.spec-cli/config.json` | Project-local config (baseUrl, auth, headers) |

## Planned

- MCP resources and prompts (`spec resources` / `spec prompts`)
- OAuth for OpenAPI and GraphQL (not just MCP)

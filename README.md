# api-spec-cli

CLI for AI agents to explore and call OpenAPI, GraphQL, and MCP APIs. Output is JSON by default — compact, parseable, token-efficient.

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

`list` is compact by default — just IDs, no schemas. Use `--filter`, `--tag`, `--limit` to narrow down.

```bash
spec list --spec agno                          # Registered spec (uses cache)
spec list --spec petstore --filter pet         # Search by keyword
spec list --spec petstore --tag pets           # OpenAPI: filter by tag
spec list --spec hashnode --tag mutation        # GraphQL: filter by kind
spec list --spec petstore --limit 10           # First 10 only
spec list --spec petstore --limit 10 --offset 10  # Next 10
spec list --mcp-http https://docs.agno.com/mcp # Inline: no registration needed
```

Compact output:
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

MCP HTTP and SSE servers that require OAuth 2.1 are handled automatically. spec-cli detects the auth requirement on `spec add` and completes the flow before returning.

### Interactive (browser) — default

```bash
spec add github --mcp-http https://api.githubcopilot.com/mcp/
# Browser opens automatically if OAuth is required
```

### Headless / device flow

```bash
spec add myserver --mcp-http https://... --oauth-flow device
# Prints a URL to stderr — open in any browser to authorize
```

### Machine / CI (client credentials)

```bash
spec add myserver --mcp-http https://... \
  --oauth-client-id <id> --oauth-client-secret <secret>
```

### Re-authenticate

```bash
spec auth myserver           # Re-run the OAuth flow
spec auth myserver --revoke  # Clear stored token only
```

Tokens are stored in `~/spec-cli-config/tokens/<name>.json` — separate from the cache, not touched by `spec refresh`.

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

JSON by default. Errors go to stderr as `{"error": "message"}` with a non-zero exit code.

```bash
spec list --spec petstore --format text
spec show --spec petstore getPetById --format yaml
spec list --spec petstore --format=json    # equals syntax also works
```

## Token Efficiency

- `list` returns only IDs by default — no schemas
- `show` resolves `$ref` compactly — nested refs show as names, not explosions
- `types` lets you inspect one schema at a time
- `--limit` / `--offset` paginate large APIs
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
| `.spec-cli/config.json` | Project-local config (baseUrl, auth, headers) |

## Planned

- `spec import <file>` — bulk import servers from VS Code `mcp.json` or Claude Desktop config format

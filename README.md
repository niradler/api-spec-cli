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
spec add <name> --mcp-http <url>           [--header k=v]
spec add <name> --mcp-sse <url>            [--header k=v]
spec add <name> --mcp-stdio "<cmd args>"   [--env KEY=VAL]
                                           [--description <text>]  (all types)
```

Headers are sent on every request. For stdio MCP, use `--env` to pass environment variables to the subprocess.

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

## Storage

| Path | Purpose |
|---|---|
| `~/spec-cli-config/registry.json` | Global named registry |
| `~/spec-cli-config/cache/<name>.json` | Cached spec per registered entry |
| `.spec-cli/config.json` | Project-local config (baseUrl, auth, headers) |

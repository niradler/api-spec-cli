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

The CLI follows a progressive discovery pattern. You never dump an entire API spec at once — instead you narrow down to what you need.

### Step 1: Load the spec

```bash
# OpenAPI
spec load https://petstore3.swagger.io/api/v3/openapi.json
spec load ./openapi.yaml

# GraphQL (auto-introspects)
spec load https://gql.hashnode.com

# MCP — stdio transport (spawn a local server)
spec load --mcp-stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"

# MCP — SSE transport
spec load --mcp-sse http://localhost:3000/sse

# MCP — Streamable HTTP transport
spec load --mcp-http https://docs.agno.com/mcp
```

Output tells you what was loaded:
```json
{ "ok": true, "type": "mcp", "transport": "streamable-http", "toolCount": 1 }
```

### Step 2: Find what you need

`list` is compact by default — just IDs, no schemas. Use `--filter`, `--tag`, `--limit` to narrow down.

```bash
spec list                          # All operations/tools (compact IDs only)
spec list --filter publish         # Search by keyword
spec list --tag pets               # OpenAPI: filter by tag
spec list --tag mutation           # GraphQL: filter by kind (query/mutation/subscription)
spec list --limit 10               # First 10 only
spec list --limit 10 --offset 10   # Next 10
```

Compact output (token-efficient):
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

Use `--compact false` for full details (including `inputSchema` for MCP tools).

### Step 3: Inspect one operation or tool

`show` gives you everything you need to make a call — params, body schema, response, and related types — in one call.

```bash
spec show publishPost              # GraphQL: by operation name
spec show getPetById               # OpenAPI: by operationId
spec show /pet/{petId}             # OpenAPI: by path
spec show "GET /pet/{petId}"       # OpenAPI: by method + path
spec show search_agno              # MCP: by tool name
```

MCP output includes the full `inputSchema` so you know exactly what arguments to pass.

### Step 4: Drill into types (OpenAPI/GraphQL only)

```bash
spec types                         # List all schema/type names
spec types Pet                     # Inspect one schema
spec types PublishPostInput        # Inspect a GraphQL input type
```

### Step 5: Call the API

```bash
# Set base URL and auth first (persisted across calls — OpenAPI/GraphQL)
spec config set baseUrl https://petstore3.swagger.io/api/v3
spec config set auth YOUR_TOKEN

# OpenAPI calls
spec call getPetById --var petId=1
spec call findPetsByStatus --query status=available
spec call addPet --data '{"name":"Rex","photoUrls":[]}'

# GraphQL calls (auto-generates query from schema)
spec call me
spec call publication --var host=blog.hashnode.dev

# MCP calls — use --var for individual args or --data for the full JSON object
spec call search_agno --var query="how to create an agent"
spec call read_file --data '{"path":"/tmp/hello.txt"}'
```

## Config

Persistent config stored in `.spec-cli/config.json`. Set once, used for all calls.

```bash
spec config set baseUrl https://api.example.com
spec config set auth my-token                        # Auto-adds "Bearer " prefix
spec config set auth "Basic dXNlcjpwYXNz"            # Or explicit auth header
spec config set headers.X-API-Key abc123              # Custom headers (dot notation)
spec config get                                       # Show all config
spec config unset auth                                # Remove a key
```

## Validate

Check an OpenAPI spec for errors before using it:

```bash
spec validate https://api.example.com/openapi.json
```

Reports broken `$ref` references, missing required fields, duplicate operationIds, invalid schema types, and more.

## Output Format

JSON by default. Use `--format text` or `--format yaml` for alternatives:

```bash
spec list --format text
spec show getPetById --format yaml
```

Errors always go to stderr as JSON: `{"error": "message"}` with non-zero exit code.

## Token Efficiency

The CLI is designed to minimize context window usage for AI agents:

- `list` returns only IDs by default (not full schemas)
- `show` resolves schemas compactly — nested refs show as names, not deep explosions
- `types` lets you inspect one type at a time instead of loading all schemas
- `--limit` and `--offset` paginate large APIs
- `--filter` and `--tag` narrow results before output

## Storage

All state lives in `.spec-cli/` in the working directory:
- `spec.json` — loaded spec cache
- `config.json` — base URL, auth, headers

Add `.spec-cli/` to your `.gitignore`.

# spec-cli

Agent-friendly CLI for exploring and calling OpenAPI and GraphQL APIs. Designed for AI coding agents — all output is structured JSON by default, with optional text and YAML formats.

## Install

```bash
npm install -g api-spec-cli
```

Or with bun:

```bash
bun install -g api-spec-cli
```

Or run without installing:

```bash
npx api-spec-cli <command>
bunx api-spec-cli <command>
```

## Quick Start

```bash
# Load an OpenAPI spec
spec load https://petstore3.swagger.io/api/v3/openapi.json

# Load a GraphQL endpoint (introspection)
spec load https://gql.hashnode.com

# List operations
spec list
spec list --filter pets

# Show operation details
spec show getPetById
spec show publishPost

# Call an endpoint
spec config set baseUrl https://petstore3.swagger.io/api/v3
spec call findPetsByStatus --query status=available

# GraphQL with auth
spec config set auth YOUR_TOKEN
spec call me
```

## Commands

### `spec load <file-or-url>`

Load an API spec from a local file (JSON/YAML) or URL.

- **OpenAPI/Swagger**: Detects JSON or YAML, supports v2 and v3
- **GraphQL**: Runs introspection query on the endpoint

```bash
spec load ./openapi.yaml
spec load https://api.example.com/openapi.json
spec load https://gql.example.com/graphql
```

### `spec list [--filter <text>]`

List all operations in the loaded spec.

```bash
spec list                    # all operations
spec list --filter user      # filter by keyword
```

**OpenAPI output**: `id`, `method`, `path`, `summary`, `tags`, `deprecated`
**GraphQL output**: `id`, `kind` (query/mutation/subscription), `description`, `args`, `returnType`

### `spec show <operation>`

Show full details of an operation.

```bash
spec show getPetById          # by operationId
spec show /pet/{petId}        # by path
spec show "GET /pet/{petId}"  # by method + path
spec show publishPost         # GraphQL operation name
```

For OpenAPI: resolves `$ref` references in parameters, request body, and responses.
For GraphQL: includes related types with field definitions.

### `spec call <operation> [options]`

Execute an API request.

```bash
# OpenAPI
spec call addPet --data '{"name":"Rex","photoUrls":[]}'
spec call getPetById --var petId=1
spec call findPetsByStatus --query status=available
spec call updatePet --method PUT --data '{"id":1,"name":"Rex"}'

# GraphQL
spec call me
spec call publication --var host=blog.example.com
spec call publishPost --data '{"query":"mutation { ... }"}'
```

**Options:**
| Flag | Description |
|------|-------------|
| `--data '{"key":"val"}'` | Request body (JSON) |
| `--query key=val` | Query parameter (repeatable) |
| `--header key=val` | Per-request header (repeatable) |
| `--var key=val` | Path variable or GraphQL variable (repeatable) |
| `--method GET\|POST\|...` | Override HTTP method |

For GraphQL calls without `--data`, the CLI auto-generates a query from the operation's schema, selecting scalar fields from the return type.

### `spec validate <file-or-url>`

Validate an OpenAPI spec and report errors and warnings.

```bash
spec validate ./openapi.yaml
spec validate https://api.example.com/openapi.json
```

Checks:
- Required fields (`info`, `info.title`, `info.version`, `paths`)
- Valid HTTP methods and schema types
- Unique `operationId` values
- Broken `$ref` references
- Array schemas have `items`
- Path parameters are declared
- Server/host definitions
- Unusual patterns (request body on GET)

### `spec config`

Manage persistent configuration stored in `.spec-cli/config.json`.

```bash
spec config get                              # show all config
spec config get baseUrl                      # show single key
spec config set baseUrl https://api.example.com
spec config set auth my-api-token            # adds Bearer prefix
spec config set auth "Bearer my-token"       # explicit Bearer
spec config set auth "Basic dXNlcjpwYXNz"   # Basic auth
spec config set headers.X-API-Key abc123     # custom header (dot notation)
spec config unset headers.X-API-Key          # remove a key
```

## Output Formats

All commands support `--format`:

```bash
spec list --format json     # JSON (default)
spec list --format text     # human-readable
spec list --format yaml     # YAML
```

Errors always output as JSON to stderr for reliable agent parsing.

## GraphQL Coverage

Full GraphQL schema support via introspection:
- **Queries** — all root query fields
- **Mutations** — all root mutation fields
- **Subscriptions** — all root subscription fields
- **Types** — input objects, enums, scalars, object types with fields
- **Args** — full argument definitions with types and defaults

## For AI Agents

This CLI is designed to be used by AI coding agents (Claude, GPT, etc.) as an MCP tool or shell command:

1. **Structured output** — JSON by default, every field is predictable
2. **Error format** — `{"error": "message"}` on stderr, non-zero exit code
3. **Discoverable** — `list` and `show` let agents explore APIs without docs
4. **Auto-query building** — GraphQL calls auto-generate queries from the schema
5. **Persistent config** — set auth once, use across calls
6. **No interactive prompts** — everything is flags and args

## Storage

All state is stored in `.spec-cli/` in the current directory:
- `spec.json` — cached loaded spec
- `config.json` — base URL, headers, auth

Add `.spec-cli/` to your `.gitignore`.

## Dependencies

- [yaml](https://www.npmjs.com/package/yaml) — YAML parsing (for OpenAPI YAML specs and YAML output)

No other runtime dependencies. Works with Node.js 18+ or Bun (uses native `fetch`).

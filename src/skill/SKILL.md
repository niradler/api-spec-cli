---
name: api-spec-cli
description: Use when you need to explore or call an OpenAPI, GraphQL, or MCP API from the shell — register a spec once, search/list/inspect operations token-efficiently, then call them. Prefer this over loading whole specs or wiring an MCP client into context.
---

# Exploring and calling APIs with `spec`

`spec` (the `api-spec-cli` package) turns any OpenAPI, GraphQL, or MCP server into a small set of shell commands. It is built for agents: output is TOON by default, you load only the operation you need, and you can search across many specs at once instead of holding full schemas in context.

Install: `npm install -g api-spec-cli` (or `npx api-spec-cli <command>`).

## The workflow

Work in four steps. Each step narrows what you load into context — never fetch a whole spec when you can grep then show one operation.

1. **Register once** — `spec add <name> ...`. Fetches and caches; later commands hit the cache.
2. **Search** — `spec grep <pattern>` across all specs, or `spec list --spec <name>` for one. Both return compact IDs only.
3. **Inspect one** — `spec show --spec <name> <op>` returns everything needed to call it (params, body, response, related types) in a single result.
4. **Call** — `spec call --spec <name> <op> ...`.

## Register a spec

```bash
spec add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json --base-url https://petstore3.swagger.io/api/v3
spec add hashnode --graphql https://gql.hashnode.com
spec add agno --mcp-http https://docs.agno.com/mcp
spec add fs --mcp-stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"
```

You can skip registration and pass an inline source on any command: `--openapi <url>`, `--graphql <url>`, `--mcp-http <url>`, `--mcp-sse <url>`, `--mcp-stdio "<cmd>"`.

## Discover without burning context

```bash
spec grep search                 # substring match across every registered spec
spec grep "get*"                 # glob
spec list --spec petstore        # compact IDs, no schemas
spec list --spec petstore --filter pet --limit 10
spec list --spec petstore --top 10   # the 10 most-called operations first
spec show --spec petstore getPetById  # full detail for ONE operation
spec types --spec petstore Pet        # one schema at a time (OpenAPI/GraphQL)
```

`list` is compact by default — add `--compact false` only when you actually need schemas.

## Call

```bash
spec call --spec petstore getPetById --var petId=1
spec call --spec petstore findPetsByStatus --query status=available
spec call --spec petstore addPet --data '{"name":"Rex","photoUrls":[]}'
spec call --spec hashnode publication --var host=blog.hashnode.dev
spec call --spec agno search_agno --var query="how to create an agent"
echo '{"query":"agents"}' | spec call --spec agno search_agno --data -
```

## Output formats — pick the cheapest that works

```bash
spec list --spec petstore --format toon   # default
spec list --spec petstore --format json   # pretty-printed JSON
spec show --spec petstore getPetById --format yaml
```

`toon` (Token-Oriented Object Notation) is the densest for tabular/list data and is the default when feeding results back into a model. Errors are always JSON on stderr. Help is always plain text.

## Usage ranking

`spec` records which operations you call. Use it to surface the operations that matter:

```bash
spec list --spec petstore --top 5   # rank by call count
spec usage                          # all recorded usage
spec usage petstore                 # ranked operations for one spec
```

Set `SPEC_NO_USAGE=1` to disable tracking.

## Secrets and per-call overrides

Never paste raw secrets into the registry. Store a placeholder and let it expand from the environment at call time:

```bash
spec add gh --mcp-http https://api.example.com/mcp --header "Authorization=Bearer ${GH_TOKEN}"
spec config set auth '${API_TOKEN}'
```

Override a registered spec's connection at call time without editing it:

```bash
SPEC_URL=https://staging.example.com/mcp spec call --spec gh some_tool
SPEC_HEADER_X_TENANT=acme spec list --spec gh
```

A `.env` file next to where you run `spec` is auto-loaded (real environment variables win over it).

## Auth (MCP OAuth)

OAuth 2.1 MCP servers are handled automatically on `spec add` (browser flow opens; DCR servers need no flags). For pre-registered apps like GitHub, pass `--oauth-client-id` and `--oauth-callback-port`. Re-authenticate with `spec auth <name>`; tokens refresh automatically and persist across invocations.

## Quick reference

```bash
spec specs                     # list registered specs
spec grep <pattern>            # search across all specs
spec list --spec <name>        # compact operation list
spec show --spec <name> <op>   # full detail for one operation
spec call --spec <name> <op>   # call it
spec usage [<name>]            # usage ranking
spec validate <file-or-url>    # check an OpenAPI spec for errors
spec help                      # full flag reference
```

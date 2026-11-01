---
name: spec-cli
description: Use when you need to explore or call an OpenAPI, GraphQL, or MCP API from the shell — register a spec once, search/list/inspect operations token-efficiently, then call them. Prefer this over loading whole specs or wiring an MCP client into context.
---

# Exploring and calling APIs with `spec`

`spec` (npm `api-spec-cli`) turns any OpenAPI, GraphQL or MCP server into shell commands built for agents: TOON output, ranked search across many specs, and you load only the one operation you call.

Install: `npm install -g api-spec-cli` (or `npx api-spec-cli <command>`).

## Workflow — narrow before you load

Works like `cli --help` → `cli <command> --help`: search returns one line per tool; `show` returns the full description and schema for the one you pick.

1. **Register once** — `spec add <name> --openapi <url>` (or `--graphql`, `--mcp-http`, `--mcp-sse`, `--mcp-stdio "<cmd>"`). Fetched once, cached 30m.
2. **Search** — `spec search <words>` → ranked hits `rank, spec, type, id, description` (one-line summary, same shape for every spec type). Page with `--limit` (default 20) / `--offset`; scope with `--spec a,b`.
3. **Inspect one** — `spec show --spec <spec> <id>` → full description, params, body, responses / input schema.
4. **Call** — `spec call --spec <spec> <id> --var k=v --query k=v --data '<json>'`.

Flags for any command: `spec <command> --help`. Overview: `spec --help`.

```bash
spec add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json
spec search "find pet by id"                 # all enabled specs, best match first
spec search issue --spec github,jira --limit 10 --offset 10
spec search "get*"                           # * or ? = glob on ids, paths, descriptions
spec show --spec petstore getPetById
spec call --spec petstore getPetById --var petId=1
```

Without registering, replace `--spec <name>` with an inline source on `list`/`show`/`call`/`types`/`resources`/`prompts`: `--openapi <url>`, `--mcp-http <url>`, …

## Browse one spec

```bash
spec specs                                 # registered specs
spec list --spec petstore                  # first 20 compact ids
spec list --spec petstore --filter pet --tag pets --top 10
spec types --spec petstore Pet             # one schema (OpenAPI/GraphQL)
spec resources --spec docs                 # MCP resources + templates
spec resources --spec docs page --var slug=intro   # read one (name, URI or template)
spec prompts --spec docs                   # MCP prompts + arguments
spec prompts --spec docs summarize --var topic=billing   # rendered messages
```

Never dump a large catalog (`--limit 0`) when search or `--filter` will do. A spec that fails to load shows under `unavailable`; other specs are still searched.

## Call

```bash
spec call --spec petstore findPetsByStatus --query status=available
spec call --spec petstore addPet --data '{"name":"Rex","photoUrls":[]}'
echo '{"query":"agents"}' | spec call --spec agno search_docs --data -
spec call --spec gh get_me --auth-from other --base-url https://staging.example.com
```

Output over 30000 chars is replaced by a stub with `path` to `~/.spec-cli/results/*.json` — read or `rg` that file. Use `--format json|yaml|text` only when TOON doesn't fit.

## Secrets and auth

Never store raw secrets: use `${VAR}`, `env:NAME` or `file:/path` (`spec add gh --mcp-http <url> --auth env:GH_TOKEN`). A `.env` in the working directory is auto-loaded. OAuth MCP servers authenticate on `spec add`; re-run with `spec auth <name>`. Env vars and per-call overrides: `spec config --help`.

## Cache

Tools cached 30m, call results 1m. `spec refresh <name>` re-fetches one spec; `SPEC_NO_CACHE=1` bypasses caching.

## MCP gateway

`spec mcp --specs a,b` (stdio) or `spec mcp --transport http --auth env:SPEC_GATEWAY_TOKEN`. Meta mode exposes `list_specs`, `list_tools` / `search_tools` (same ranked one-line hits, `spec`/`specs`/`limit`/`offset`), `get_tool` (full schema), `call_tool`. `?mode=tools` exposes tools directly; `&specs=a,b&tools=a.t1` narrows. See `spec mcp --help` and the README.

## Guardrails

`spec policy` lists call-blocking rules (`spec policy --help`). `spec usage [name]` and `spec list --top N` rank by call count.

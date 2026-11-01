export const HELP = `spec-cli — Explore and call APIs (OpenAPI, GraphQL, MCP) from the command line.
Output is TOON (--format json|yaml|text). Results over 30000 chars spill to a file (--max-bytes).

WORKFLOW (load only what you need):
  1. spec add <name> --openapi <url>       Register once (--graphql | --mcp-http | --mcp-sse | --mcp-stdio)
  2. spec search <words> [--spec a,b]      Ranked tools across specs: rank, spec, type, id, description
  3. spec show --spec <name> <id>          Everything needed to call one tool
  4. spec call --spec <name> <id> --var k=v --query k=v --data '<json>'
  MCP specs may also expose resources and prompts: spec list shows their counts;
  read them with spec resources / spec prompts.
  No registration: replace --spec <name> with --openapi <url> (etc.) on list/show/call/types.

COMMANDS:
  search <query>     Ranked search; * or ? = glob
  list               Operations of one spec (filter, tag, top used)
  show <op>          Operation/tool details
  call <op>          Call an operation or MCP tool
  types [type]       Schema/type names (OpenAPI/GraphQL)
  resources [uri]    List MCP resources, or read one
  prompts [name]     List MCP prompts, or get one
  add <name>         Register a spec (auth, headers, OAuth)
  specs              Registered specs
  refresh <name>     Re-fetch a spec (cache is 30m)
  remove | enable | disable <name>
  auth <name>        Re-authenticate an OAuth MCP spec
  config             Persisted defaults, secrets, env vars
  policy             Call-blocking rules
  usage [name]       Call-count ranking
  mcp                Serve specs as an MCP gateway
  import <file>      Register servers from mcp.json
  validate <src>     Check an OpenAPI spec
  skill install      Install the agent guide (spec skill path prints it)

  spec <command> --help    Flags and examples for one command
  -v, --version            Print the version`;

const SOURCE = `Source: --spec <name> | --openapi <url-or-file> | --graphql <url> | --mcp-http <url> | --mcp-sse <url> | --mcp-stdio "<cmd>"`;

const COMMAND_HELP: Record<string, string> = {
  search: `spec search <query> [--spec a,b] [--limit 20] [--offset 0]
Ranked full-text search over names, paths, summaries, descriptions and tags.
Hits: rank, spec, type, id, description (one line). Next: spec show --spec <spec> <id>.
  spec search "delete a pet"             All enabled specs
  spec search issue --spec github,jira   Only these specs
  spec search issue --limit 10 --offset 10
  spec search "get*"                     Glob on ids, paths, descriptions
Specs that fail to load are listed under unavailable. Alias: spec grep.`,
  list: `spec list --spec <name> [--filter s] [--tag t] [--top n] [--limit 20] [--offset 0]
Compact operations of one spec. Across specs use spec search.
  --filter user      Substring match       --tag pets   OpenAPI tag / GraphQL kind
  --top 10           Most-called first     --limit 0    Everything
  --compact false    Full details
${SOURCE}`,
  show: `spec show --spec <name> <op>
Params, body, responses and related types for one operation, or an MCP tool's input schema.
<op> is an operation id, path or tool name.
${SOURCE}`,
  call: `spec call --spec <name> <op> [inputs]
  --var petId=1              Path / GraphQL variable (repeatable)
  --query status=available   Query param (repeatable)
  --data '{"name":"Rex"}'    JSON body / MCP args (--data - reads stdin, --data-file f.json)
  --header X-Tenant=acme     Extra header (repeatable)
  --method PUT               Override HTTP method
  --auth <token> | --auth-from <spec> | --base-url <url>   Per-call overrides
Run spec show first for the inputs. Policies may block calls (spec policy).
${SOURCE}`,
  types: `spec types --spec <name> [TypeName]
List schema/type names, or inspect one (OpenAPI/GraphQL).
${SOURCE}`,
  resources: `spec resources --spec <name> [resource] [--var k=v] [--filter s] [--limit 20] [--offset 0]
Without a resource: list MCP resources and resource templates (filter and page with --filter/--limit/--offset).
With one: read it. <resource> is a URI, a resource or template name, or a URI template.
  spec resources --spec docs                               List
  spec resources --spec docs readme                        Read by name
  spec resources --spec docs file:///README.md             Read by URI
  spec resources --spec docs repo-file --var path=src/a.ts Expand a template
Policies match resource:<uri> as the tool (spec policy add --tool "resource:file:///etc/*"). Alias: spec resource.
${SOURCE}`,
  prompts: `spec prompts --spec <name> [prompt] [--var k=v] [--data '<json>'] [--filter s] [--limit 20] [--offset 0]
Without a prompt: list MCP prompts and their arguments (filter and page with --filter/--limit/--offset).
With one: get the rendered prompt messages.
  spec prompts --spec docs                                 List
  spec prompts --spec docs summarize --var topic=billing   Get with arguments
  spec prompts --spec docs summarize --data '{"topic":"billing"}'
Missing required arguments are reported before calling the server.
Policies match prompt:<name> as the tool. Alias: spec prompt.
${SOURCE}`,
  add: `spec add <name> --openapi <url-or-file> | --graphql <url> | --mcp-http <url> | --mcp-sse <url> | --mcp-stdio "<cmd>"
  --description <text>  --base-url <url>  --auth <token>  --header k=v
  --env KEY=VAL  --cwd <dir>               stdio only
  --allow-tool <glob>  --disable-tool <glob>
  --oauth-flow browser|device|client_credentials  --oauth-client-id <id>
  --oauth-client-secret <secret>  --oauth-callback-port <port>
Secrets: use \${VAR}, env:NAME or file:/path instead of raw values.
  spec add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json
  spec add gh --mcp-http https://api.example.com/mcp --auth env:GH_TOKEN`,
  specs: `spec specs [--filter s] [--compact false]
List registered specs. Manage: spec remove | enable | disable | refresh <name>.`,
  refresh: `spec refresh <name>
Re-fetch a spec and rewrite its cache. Caches: tools 30m, call results 1m (SPEC_NO_CACHE=1 bypasses).`,
  auth: `spec auth <name> [--revoke]
Re-run OAuth for an MCP spec, or clear its stored token. Tokens refresh automatically.`,
  config: `spec config get | set <key> <value> | unset <key>
Defaults in .spec-cli/config.json (lowest priority): baseUrl, auth, headers.<Name>.
Values may use \${VAR}, env:NAME or file:/path. .env in the working dir is auto-loaded.
Env:
  SPEC_HOME              Registry, cache, tokens (default ~/.spec-cli)
  SPEC_URL               Override a spec's MCP/GraphQL endpoint for one call
  SPEC_HEADER_<NAME>     Add a header (SPEC_HEADER_X_TENANT -> X-Tenant)
  SPEC_NO_CACHE=1        Disable caches   SPEC_META_CACHE_MS / SPEC_CALL_CACHE_MS   TTLs
  SPEC_NO_USAGE=1  SPEC_NO_POLICY=1  SPEC_NO_DOTENV=1  SPEC_MAX_STDOUT=<chars>
  MCP_MAX_RETRIES  MCP_RETRY_DELAY  SPEC_OAUTH_CALLBACK_PORT`,
  policy: `spec policy [add | show <id> | remove <id> | clear] [--spec <name>] [--local]
Deny rules checked on spec call.
  spec policy add --id no-prod --spec k8s --tool restart --when pod_name.prefix=prod --message "no prod"
  spec policy add --data '{"id":"no-deletes","tool":{"regex":"^delete_"},"message":"no deletes"}'
  --local writes .spec-cli/policy.json; --policies-path <dir> for per-spec files.`,
  usage: `spec usage [name]
Recorded call counts; with a name, that spec's operations ranked. SPEC_NO_USAGE=1 disables.`,
  mcp: `spec mcp [--transport stdio|http] [--mode meta|tools] [--specs a,b] [--tools a.t1,b.t2]
Serve registered specs over MCP. Meta mode tools: list_specs, list_tools, search_tools, get_tool, call_tool.
  --host <host> --port <port> --auth env:TOKEN   HTTP (/mcp, add ?mode=tools&specs=a)
  --config <file>                                Gateway settings (see README)`,
  import: `spec import <file>
Register MCP servers from mcp.json, Claude Desktop or Cursor config.`,
  validate: `spec validate <file-or-url>
Check an OpenAPI spec for errors.`,
  skill: `spec skill install | path
Install the agent guide into ~/.claude/skills/, or print its location.`,
  remove: `spec remove <name>
Delete a spec from the registry. List names: spec specs.`,
  enable: `spec enable <name>
Enable a disabled spec. List names: spec specs.`,
  disable: `spec disable <name>
Disable a spec without removing it (excluded from search and the gateway).`,
};

COMMAND_HELP.grep = COMMAND_HELP.search!;
COMMAND_HELP.resource = COMMAND_HELP.resources!;
COMMAND_HELP.prompt = COMMAND_HELP.prompts!;

export function commandHelp(command: string | undefined): string {
  return (command && COMMAND_HELP[command]) || HELP;
}

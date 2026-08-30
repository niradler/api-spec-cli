import yargs from "yargs";
import { listOperations } from "./commands/list.js";
import { showOperation } from "./commands/show.js";
import { callOperation } from "./commands/call.js";
import { configCmd } from "./commands/config.js";
import { validateSpec } from "./commands/validate.js";
import { typesCmd } from "./commands/types.js";
import { addCmd } from "./commands/add.js";
import { specsCmd, registryMutate } from "./commands/specs.js";
import { grepCmd } from "./commands/grep.js";
import { authCmd } from "./commands/auth.js";
import { usageCmd } from "./commands/usage.js";
import { skillCmd } from "./commands/skill.js";
import { importCmd } from "./commands/import.js";
import { loadDotenv } from "./dotenv.js";
import { err, setFormat, setMaxStdout } from "./output.js";

const HELP = `spec-cli — Explore and call APIs from the command line.
Output is TOON by default. Designed for AI agents but works for humans too.

Every command is stateless — specify the spec source on each call.

SPEC SOURCE (required on every list/show/call):
  --spec <name>                        Use a registered spec (auto-fetches + caches)
  --openapi <url-or-file>              OpenAPI inline (no registration needed)
  --graphql <url>                      GraphQL inline
  --mcp-http <url>                     MCP streamable-HTTP inline
  --mcp-sse <url>                      MCP SSE inline
  --mcp-stdio "<cmd args>"             MCP stdio inline

REGISTRY (register once, use anywhere):
  spec add <name> --openapi <url>      Register an OpenAPI spec
  spec add <name> --graphql <url>      Register a GraphQL endpoint
  spec add <name> --mcp-http <url>     Register an MCP server (streamable-HTTP)
  spec add <name> --mcp-sse <url>      Register an MCP server (SSE)
  spec add <name> --mcp-stdio "<cmd>"  Register an MCP server (stdio)
    Options: --description <text>  --base-url <url>  --auth <token>
             --header k=v (repeatable)  --env KEY=VAL (repeatable, stdio only)
             --cwd <path> (stdio only)
             --allow-tool <glob> (repeatable)
             --disable-tool <glob> (repeatable)
             --oauth-flow browser|device|client_credentials
             --oauth-client-id <id>                Pre-registered OAuth client ID
             --oauth-client-secret <secret>        Client secret (stored securely, not in registry)
             --oauth-callback-port <1-65535>        Fixed local port for browser callback

  spec specs                           List all registered specs
  spec specs --filter datadog          Search registered spec names
  spec specs --compact false           Show full entry config
  spec remove <name>                   Delete from registry
  spec enable <name>                   Enable a disabled spec
  spec disable <name>                  Disable without removing
  spec refresh <name>                  Force re-fetch and update cache

DISCOVER:
  spec list --spec <name>              First 20 operations/tools (compact IDs)
  spec list --spec <name> --filter user       Search by keyword
  spec list --spec <name> --tag pets          OpenAPI tag or GraphQL kind
  spec list --spec <name> --limit 10          Page size (default 20; 0 = all)
  spec list --spec <name> --offset 20         Next page
  spec list --spec <name> --top 10            Rank by call count (most-used first)
  spec list --mcp-http <url>           Inline: no registration needed
  spec grep <pattern>                  Search across all registered specs (first 20)
  spec grep <pattern> --spec <name>    Search within one spec
  spec grep <pattern> --limit 10       Page grep matches (default 20; 0 = all)
  spec usage                           Show recorded usage for all specs
  spec usage <name>                    Ranked operations for one spec

INSPECT:
  spec show --spec <name> <op>         Operation details (params, body, responses)
  spec show --spec <name> <tool>       MCP tool input schema
  spec types --spec <name>             List all schema/type names (OpenAPI/GraphQL)
  spec types --spec <name> <TypeName>  Inspect one type

CALL:
  spec call --spec <name> <op> --var petId=1            Path/GraphQL vars
  spec call --spec <name> <op> --query status=available  Query params
  spec call --spec <name> <op> --data '{"name":"Rex"}'   JSON body / MCP args
  spec call --spec <name> <op> --data-file args.json     Body from file
  spec call --spec <name> <op> --data -                  Read JSON body from stdin (pipe)
  spec call --spec <name> <op> --header X-Custom=val     Extra headers
  spec call --spec <name> <op> --method PUT              Override HTTP method

PER-CALL OVERRIDES (win over registry entry config):
  --auth <token>        Override auth for this call
  --auth-from <name>    Use stored OAuth access token from another spec
  --base-url <url>      Override base URL for this call
  --header k=v          Merge/override headers for this call

CONFIG (persisted in .spec-cli/config.json — lowest priority):
  spec config set baseUrl https://api.example.com
  spec config set auth <token>
  spec config set headers.X-API-Key <key>
  spec config get
  spec config unset auth

OTHER:
  spec auth <name>                     Re-authenticate an OAuth-protected MCP spec
  spec auth <name> --revoke            Clear stored OAuth token
  spec validate <file-or-url>          Check OpenAPI spec for errors
  spec skill install                   Install the agent skill into ~/.claude/skills/
  spec skill path                      Print the bundled SKILL.md location
  spec import <file>                   Bulk-register from mcp.json / Claude Desktop / Cursor
  --format json|text|yaml|toon         Output format (default: toon)
  --max-bytes <n>                      Spill stdout over this size to a results file (default 30000; 0 = never)

SECRETS & OVERRIDES:
  Stored values (auth, headers, oauth secrets) may use \${VAR}, env:NAME, or file:/path.
  A .env file in the working directory is auto-loaded (real env vars take precedence).
  SPEC_URL=<url>                  Override a registered MCP/GraphQL spec's endpoint for this call
  SPEC_HEADER_<NAME>=<value>      Add/override a header (SPEC_HEADER_X_TENANT -> X-Tenant)

ENV VARS:
  MCP_MAX_RETRIES=3               Retry attempts on connection failure (default: 3)
  MCP_RETRY_DELAY=1000            Base retry delay in ms, doubles each attempt (default: 1000)
  SPEC_OAUTH_CALLBACK_PORT=3141   Default fixed port for browser OAuth callback
  SPEC_NO_USAGE=1                 Disable usage tracking
  SPEC_NO_DOTENV=1                Disable .env auto-loading
  SPEC_MAX_STDOUT=30000           Spill formatted output above this many chars to ~/spec-cli-config/results/

EXAMPLES:
  spec add agno --mcp-http https://docs.agno.com/mcp --description "Agno docs"
  spec add petstore --openapi https://petstore3.swagger.io/api/v3/openapi.json \\
    --base-url https://petstore3.swagger.io/api/v3
  spec specs
  spec list  --spec agno
  spec show  --spec agno search_agno
  spec call  --spec agno search_agno --var query="agents"
  spec call  --spec agno search_agno --var query="foo" --header X-Tenant=acme
  spec list  --mcp-http https://docs.agno.com/mcp    (inline, no registration)`;

const specSourceOptions = {
  spec: { type: "string", describe: "Use a registered spec" },
  openapi: { type: "string", describe: "Inline OpenAPI URL or file" },
  graphql: { type: "string", describe: "Inline GraphQL URL" },
  "mcp-http": { type: "string", describe: "Inline MCP streamable-HTTP URL" },
  "mcp-sse": { type: "string", describe: "Inline MCP SSE URL" },
  "mcp-stdio": { type: "string", describe: "Inline MCP stdio command" },
};

const overrideOptions = {
  auth: { type: "string", describe: "Override auth token" },
  "auth-from": { type: "string", describe: "Use stored OAuth token from another spec" },
  "base-url": { type: "string", describe: "Override base URL" },
  header: { type: "string", array: true, describe: "Header k=v (repeatable)" },
  "allow-tool": { type: "string", array: true, describe: "Allow tool glob (repeatable)" },
  "disable-tool": { type: "string", array: true, describe: "Disable tool glob (repeatable)" },
  env: { type: "string", array: true, describe: "Env KEY=VAL (repeatable, stdio only)" },
  cwd: { type: "string", describe: "Working directory (stdio only)" },
};

const sourceOptions = { ...specSourceOptions, ...overrideOptions };

const commands = (rest) => [
  {
    command: ["list", "ls"],
    describe: "List operations or tools for a spec",
    builder: (y) =>
      y.options({
        ...sourceOptions,
        filter: { type: "string", describe: "Substring search across fields" },
        compact: { type: "string", describe: "Set false to show full details" },
        limit: { type: "string", describe: "Max results (default 20; 0 = all)" },
        offset: { type: "string", describe: "Skip the first N results" },
        tag: { type: "string", describe: "OpenAPI tag or GraphQL kind" },
        top: { type: "string", describe: "Rank by call count (most-used first)" },
      }),
    handler: () => listOperations(rest),
  },
  {
    command: "show <operation>",
    describe: "Show operation or tool details",
    builder: (y) =>
      y
        .positional("operation", { type: "string", describe: "Operation id, path, or tool name" })
        .options(sourceOptions),
    handler: () => showOperation(rest),
  },
  {
    command: "call <operation>",
    describe: "Call an operation or MCP tool",
    builder: (y) =>
      y
        .positional("operation", { type: "string", describe: "Operation id, path, or tool name" })
        .options({
          ...sourceOptions,
          data: { type: "string", describe: "JSON body / MCP args, or - for stdin" },
          "data-file": { type: "string", describe: "Read JSON body from a file" },
          var: { type: "string", array: true, describe: "Path/GraphQL var k=v (repeatable)" },
          query: { type: "string", array: true, describe: "Query param k=v (repeatable)" },
          method: { type: "string", describe: "Override HTTP method" },
        }),
    handler: () => callOperation(rest),
  },
  {
    command: ["types [type]", "type [type]"],
    describe: "List schema/type names or inspect one type",
    builder: (y) =>
      y
        .positional("type", { type: "string", describe: "Type or schema name to inspect" })
        .options(sourceOptions),
    handler: () => typesCmd(rest),
  },
  {
    command: "grep <pattern>",
    describe: "Search operations across registered specs",
    builder: (y) =>
      y
        .positional("pattern", { type: "string", describe: "Glob or substring pattern" })
        .option("spec", specSourceOptions.spec)
        .option("limit", { type: "string", describe: "Max matches (default 20; 0 = all)" })
        .option("offset", { type: "string", describe: "Skip the first N matches" }),
    handler: () => grepCmd(rest),
  },
  {
    command: "usage [name]",
    describe: "Show recorded usage",
    builder: (y) =>
      y.positional("name", { type: "string", describe: "Spec name for ranked operations" }),
    handler: () => usageCmd(rest),
  },
  {
    command: "add <name>",
    describe: "Register a spec in the registry",
    builder: (y) =>
      y.positional("name", { type: "string", describe: "Registry name" }).options({
        ...specSourceOptions,
        ...overrideOptions,
        description: { type: "string", describe: "Human-readable description" },
        "oauth-flow": {
          type: "string",
          choices: ["browser", "device", "client_credentials"],
          describe: "OAuth flow",
        },
        "oauth-client-id": { type: "string", describe: "Pre-registered OAuth client ID" },
        "oauth-client-secret": {
          type: "string",
          describe: "OAuth client secret (stored securely)",
        },
        "oauth-callback-port": { type: "number", describe: "Fixed local OAuth callback port" },
      }),
    handler: () => addCmd(rest),
  },
  {
    command: ["specs", "registry"],
    describe: "List all registered specs",
    builder: (y) =>
      y
        .option("compact", { type: "string", describe: "Set false to show full entry config" })
        .option("filter", { type: "string", describe: "Substring search on name or description" }),
    handler: () => specsCmd(rest),
  },
  {
    command: "remove <name>",
    describe: "Delete a spec from the registry",
    builder: (y) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("remove", rest),
  },
  {
    command: "enable <name>",
    describe: "Enable a disabled spec",
    builder: (y) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("enable", rest),
  },
  {
    command: "disable <name>",
    describe: "Disable a spec without removing it",
    builder: (y) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("disable", rest),
  },
  {
    command: "refresh <name>",
    describe: "Force re-fetch and update the cache",
    builder: (y) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("refresh", rest),
  },
  {
    command: "auth <name>",
    describe: "Re-authenticate or revoke an OAuth MCP spec",
    builder: (y) =>
      y
        .positional("name", { type: "string", describe: "Registry name" })
        .option("revoke", { type: "boolean", describe: "Clear the stored OAuth token" }),
    handler: () => authCmd(rest),
  },
  {
    command: ["config [action] [key] [value]", "cfg [action] [key] [value]"],
    describe: "Get, set, or unset persisted config",
    builder: (y) =>
      y
        .positional("action", { type: "string", choices: ["get", "show", "set", "unset"] })
        .positional("key", { type: "string" })
        .positional("value", { type: "string" }),
    handler: () => configCmd(rest),
  },
  {
    command: "validate <source>",
    describe: "Check an OpenAPI spec for errors",
    builder: (y) => y.positional("source", { type: "string", describe: "OpenAPI file or URL" }),
    handler: () => validateSpec(rest),
  },
  {
    command: "import <file>",
    describe: "Bulk-register MCP servers from mcp.json",
    builder: (y) =>
      y.positional("file", { type: "string", describe: "mcp.json or Claude Desktop config" }),
    handler: () => importCmd(rest),
  },
  {
    command: "skill [sub]",
    describe: "Manage the bundled agent skill",
    builder: (y) =>
      y
        .positional("sub", { type: "string", choices: ["install", "path"] })
        .option("install", { type: "boolean" })
        .option("path", { type: "boolean" }),
    handler: () => skillCmd(rest),
  },
];

function isHelpRequest(args) {
  return !args[0] || args[0] === "help" || args.includes("--help") || args.includes("-h");
}

export async function run(argv) {
  loadDotenv();

  const args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--format" && i + 1 < argv.length) setFormat(argv[++i]);
    else if (argv[i].startsWith("--format=")) setFormat(argv[i].slice(9));
    else if (argv[i] === "--max-bytes" && i + 1 < argv.length) setMaxStdout(argv[++i]);
    else if (argv[i].startsWith("--max-bytes=")) setMaxStdout(argv[i].slice(12));
    else args.push(argv[i]);
  }

  if (isHelpRequest(args)) {
    console.log(HELP);
    return;
  }

  const rest = args.slice(1);
  const validationArgs = args.filter((arg) => arg !== "-");
  const cli = yargs(validationArgs)
    .scriptName("spec")
    .help(false)
    .version(false)
    .strict()
    .demandCommand(1, "No command given. Run 'spec help' for usage.")
    .fail((msg, error) => {
      err(error?.message || msg);
      process.exit(1);
    })
    .exitProcess(false);

  for (const command of commands(rest)) cli.command(command);

  try {
    await cli.parseAsync();
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

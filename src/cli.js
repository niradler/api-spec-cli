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
import { out, err, setFormat } from "./output.js";

const HELP = `spec-cli — Explore and call APIs from the command line.
All output is JSON. Designed for AI agents but works for humans too.

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
             --oauth-flow browser|device           OAuth flow (http/sse only, default: browser)
             --oauth-client-id <id>                Pre-registered OAuth client ID
             --oauth-client-secret <secret>        Client secret (stored securely, not in registry)
             --oauth-callback-port <1-65535>        Fixed local port for browser callback

  spec specs                           List all registered specs
  spec specs --compact false           Show full entry config
  spec remove <name>                   Delete from registry
  spec enable <name>                   Enable a disabled spec
  spec disable <name>                  Disable without removing
  spec refresh <name>                  Force re-fetch and update cache

DISCOVER:
  spec list --spec <name>              All operations/tools (compact IDs)
  spec list --spec <name> --filter user       Search by keyword
  spec list --spec <name> --tag pets          OpenAPI tag or GraphQL kind
  spec list --spec <name> --limit 10          Paginate
  spec list --mcp-http <url>           Inline: no registration needed
  spec grep <pattern>                  Search across all registered specs
  spec grep <pattern> --spec <name>    Search within one spec

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
  --format json|text|yaml              Output format (default: json)

ENV VARS (MCP):
  MCP_MAX_RETRIES=3               Retry attempts on connection failure (default: 3)
  MCP_RETRY_DELAY=1000            Base retry delay in ms, doubles each attempt (default: 1000)
  SPEC_OAUTH_CALLBACK_PORT=3141   Default fixed port for browser OAuth callback

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

export async function run(args) {
  // Extract --format before routing (supports both --format json and --format=json)
  const newArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--format" && i + 1 < args.length) {
      setFormat(args[++i]);
    } else if (args[i].startsWith("--format=")) {
      setFormat(args[i].slice(9));
    } else {
      newArgs.push(args[i]);
    }
  }
  args = newArgs;

  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out({ help: HELP });
    return;
  }

  try {
    switch (cmd) {
      case "list":
      case "ls":
        await listOperations(args.slice(1));
        break;
      case "show":
        await showOperation(args.slice(1));
        break;
      case "call":
        await callOperation(args.slice(1));
        break;
      case "validate":
        await validateSpec(args.slice(1));
        break;
      case "types":
      case "type":
        await typesCmd(args.slice(1));
        break;
      case "config":
      case "cfg":
        await configCmd(args.slice(1));
        break;
      case "add":
        await addCmd(args.slice(1));
        break;
      case "specs":
      case "registry":
        await specsCmd(args.slice(1));
        break;
      case "remove":
        await registryMutate("remove", args.slice(1));
        break;
      case "enable":
        await registryMutate("enable", args.slice(1));
        break;
      case "disable":
        await registryMutate("disable", args.slice(1));
        break;
      case "refresh":
        await registryMutate("refresh", args.slice(1));
        break;
      case "grep":
        await grepCmd(args.slice(1));
        break;
      case "auth":
        await authCmd(args.slice(1));
        break;
      default:
        err(`Unknown command: ${cmd}. Run 'spec help' for usage.`);
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

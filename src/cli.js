import { loadSpec } from "./commands/load.js";
import { listOperations } from "./commands/list.js";
import { showOperation } from "./commands/show.js";
import { callOperation } from "./commands/call.js";
import { configCmd } from "./commands/config.js";
import { validateSpec } from "./commands/validate.js";
import { typesCmd } from "./commands/types.js";
import { out, err, setFormat } from "./output.js";

const HELP = `spec-cli — Explore and call APIs from the command line.
All output is JSON. Designed for AI agents but works for humans too.

WORKFLOW (follow this order):
  1. spec load <file-or-url>           Load an OpenAPI or GraphQL spec
     spec load --mcp-stdio <cmd>       Load an MCP server via stdio
     spec load --mcp-sse <url>         Load an MCP server via SSE
     spec load --mcp-http <url>        Load an MCP server via streamable HTTP
  2. spec list                         Browse operations/tools (compact IDs)
  3. spec show <operation>             Get params, body, response for one op
  4. spec call <operation> [options]   Execute the request

  Use spec types [name] to inspect a schema/type referenced by show.
  Use spec config to set baseUrl, auth, and headers before calling.

DISCOVERY (narrowing down):
  spec list                            All operations (just IDs)
  spec list --filter user              Search across all fields
  spec list --tag pets                 OpenAPI tag or GraphQL kind (query/mutation)
  spec list --limit 10 --offset 20     Paginate large APIs

INSPECT:
  spec show getPetById                 Match by operationId
  spec show /pet/{petId}               Match by path
  spec show "GET /pet/{petId}"         Match by method + path
  spec show publishPost                GraphQL operation name
  spec show read_file                  MCP tool name
  spec types                           List all schema/type names
  spec types Pet                       Inspect one schema (compact, no $ref explosion)

EXECUTE:
  spec call <op> --var petId=1                       Path or GraphQL variables
  spec call <op> --query status=available             Query string params
  spec call <op> --data '{"name":"Rex"}'              JSON body / MCP tool arguments
  spec call <op> --data-file /tmp/query.json          JSON body from file (avoids shell escaping)
  spec call <op> --header X-Custom=val                Extra headers (OpenAPI/GraphQL)
  spec call <op> --method PUT                         Override HTTP method (OpenAPI)

MCP EXAMPLES:
  spec load --mcp-stdio "npx -y @modelcontextprotocol/server-filesystem /tmp"
  spec load --mcp-sse http://localhost:3000/sse
  spec load --mcp-http https://example.com/mcp
  spec list
  spec show read_file
  spec call read_file --var path=/tmp/hello.txt
  spec call read_file --data '{"path":"/tmp/hello.txt"}'

CONFIG (persisted in .spec-cli/config.json):
  spec config set baseUrl https://api.example.com
  spec config set auth <token>                        Auto-adds Bearer prefix
  spec config set headers.X-API-Key <key>             Dot notation for nested keys
  spec config get                                     Show current config
  spec config unset auth                              Remove a key

OTHER:
  spec validate <file-or-url>          Check OpenAPI spec for errors
  --format json|text|yaml              Output format (default: json)`;

export async function run(args) {
  // Extract --format before routing
  const formatIdx = args.indexOf("--format");
  if (formatIdx !== -1) {
    setFormat(args[formatIdx + 1]);
    args = [...args.slice(0, formatIdx), ...args.slice(formatIdx + 2)];
  }

  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    out({ help: HELP });
    return;
  }

  try {
    switch (cmd) {
      case "load":
        await loadSpec(args.slice(1));
        break;
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
      default:
        err(`Unknown command: ${cmd}. Run 'spec help' for usage.`);
    }
  } catch (e) {
    err(e.message);
    process.exit(1);
  }
}

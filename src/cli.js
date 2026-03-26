import { loadSpec } from "./commands/load.js";
import { listOperations } from "./commands/list.js";
import { showOperation } from "./commands/show.js";
import { callOperation } from "./commands/call.js";
import { configCmd } from "./commands/config.js";
import { validateSpec } from "./commands/validate.js";
import { out, err, setFormat } from "./output.js";

const HELP = `spec-cli — Agent-friendly API spec explorer

Commands:
  spec load <file-or-url>              Load an OpenAPI (JSON/YAML) or GraphQL endpoint
  spec list [--filter <text>]          List all operations
  spec show <operation>                Show operation details (params, body, response)
  spec call <operation> [options]      Execute a request
  spec validate <file-or-url>          Validate an OpenAPI spec (errors + warnings)
  spec config set <key> <value>        Set config (baseUrl, headers.X-Key, auth)
  spec config get [key]                Show config
  spec config unset <key>              Remove config key

Call options:
  --data '{"key":"val"}'               Request body (JSON)
  --query key=val                      Query parameters (repeatable)
  --header key=val                     Per-request headers (repeatable)
  --var key=val                        Path variables (repeatable)
  --method GET|POST|...                Override HTTP method

Output format (all commands):
  --format json                        JSON (default, best for agents)
  --format text                        Human-readable text
  --format yaml                        YAML output

All output defaults to JSON for agent consumption.`;

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

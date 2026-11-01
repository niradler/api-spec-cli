import yargs, { type Argv, type CommandModule, type Options } from "yargs";
import { mcpCmd } from "./commands/mcp.ts";
import { listOperations } from "./commands/list.ts";
import { showOperation } from "./commands/show.ts";
import { callOperation } from "./commands/call.ts";
import { configCmd } from "./commands/config.ts";
import { validateSpec } from "./commands/validate.ts";
import { typesCmd } from "./commands/types.ts";
import { resourcesCmd } from "./commands/resources.ts";
import { promptsCmd } from "./commands/prompts.ts";
import { addCmd } from "./commands/add.ts";
import { specsCmd, registryMutate } from "./commands/specs.ts";
import { searchCmd } from "./commands/search.ts";
import { authCmd } from "./commands/auth.ts";
import { usageCmd } from "./commands/usage.ts";
import { skillCmd } from "./commands/skill.ts";
import { importCmd } from "./commands/import.ts";
import { policyCmd } from "./commands/policy.ts";
import { loadDotenv } from "./dotenv.ts";
import { err, setFormat, setMaxStdout } from "./output.ts";
import { sweepCache } from "./cache.ts";
import { migrateLegacyHome } from "./paths.ts";
import { commandHelp } from "./help.ts";
import { VERSION } from "./version.ts";

const specSourceOptions = {
  spec: { type: "string", describe: "Use a registered spec" },
  openapi: { type: "string", describe: "Inline OpenAPI URL or file" },
  graphql: { type: "string", describe: "Inline GraphQL URL" },
  "mcp-http": { type: "string", describe: "Inline MCP streamable-HTTP URL" },
  "mcp-sse": { type: "string", describe: "Inline MCP SSE URL" },
  "mcp-stdio": { type: "string", describe: "Inline MCP stdio command" },
} satisfies Record<string, Options>;

const overrideOptions = {
  auth: { type: "string", describe: "Override auth token" },
  "auth-from": { type: "string", describe: "Use stored OAuth token from another spec" },
  "base-url": { type: "string", describe: "Override base URL" },
  header: { type: "string", array: true, describe: "Header k=v (repeatable)" },
  "allow-tool": { type: "string", array: true, describe: "Allow tool glob (repeatable)" },
  "disable-tool": { type: "string", array: true, describe: "Disable tool glob (repeatable)" },
  env: { type: "string", array: true, describe: "Env KEY=VAL (repeatable, stdio only)" },
  cwd: { type: "string", describe: "Working directory (stdio only)" },
} satisfies Record<string, Options>;

const sourceOptions = { ...specSourceOptions, ...overrideOptions };

const commands = (rest: string[]): CommandModule[] => [
  {
    command: "mcp",
    describe: "Serve a configurable MCP gateway",
    builder: (y: Argv) =>
      y.options({
        transport: { type: "string", choices: ["stdio", "http"] },
        mode: { type: "string", choices: ["meta", "tools"] },
        config: { type: "string" },
        host: { type: "string" },
        port: { type: "number" },
        auth: { type: "string" },
        specs: { type: "string" },
        tools: { type: "string" },
      }),
    handler: () => mcpCmd(rest),
  },
  {
    command: ["list", "ls"],
    describe: "List operations or tools for a spec",
    builder: (y: Argv) =>
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
    builder: (y: Argv) =>
      y
        .positional("operation", { type: "string", describe: "Operation id, path, or tool name" })
        .options(sourceOptions),
    handler: () => showOperation(rest),
  },
  {
    command: "call <operation>",
    describe: "Call an operation or MCP tool",
    builder: (y: Argv) =>
      y
        .positional("operation", { type: "string", describe: "Operation id, path, or tool name" })
        .options({
          ...sourceOptions,
          data: { type: "string", describe: "JSON body / MCP args, or - for stdin" },
          "data-file": { type: "string", describe: "Read JSON body from a file" },
          var: { type: "string", array: true, describe: "Path/GraphQL var k=v (repeatable)" },
          query: { type: "string", array: true, describe: "Query param k=v (repeatable)" },
          method: { type: "string", describe: "Override HTTP method" },
          "policies-path": { type: "string", describe: "Folder of per-spec policy JSON files" },
        }),
    handler: () => callOperation(rest),
  },
  {
    command: ["types [type]", "type [type]"],
    describe: "List schema/type names or inspect one type",
    builder: (y: Argv) =>
      y
        .positional("type", { type: "string", describe: "Type or schema name to inspect" })
        .options(sourceOptions),
    handler: () => typesCmd(rest),
  },
  {
    command: ["resources [resource]", "resource [resource]"],
    describe: "List MCP resources or read one",
    builder: (y: Argv) =>
      y
        .positional("resource", { type: "string", describe: "Resource URI, name, or template" })
        .options({
          ...sourceOptions,
          filter: { type: "string", describe: "Substring search across fields" },
          limit: { type: "string", describe: "Max results (default 20; 0 = all)" },
          offset: { type: "string", describe: "Skip the first N results" },
          var: { type: "string", array: true, describe: "Template variable k=v (repeatable)" },
          "policies-path": { type: "string", describe: "Folder of per-spec policy JSON files" },
        }),
    handler: () => resourcesCmd(rest),
  },
  {
    command: ["prompts [prompt]", "prompt [prompt]"],
    describe: "List MCP prompts or get one",
    builder: (y: Argv) =>
      y.positional("prompt", { type: "string", describe: "Prompt name" }).options({
        ...sourceOptions,
        filter: { type: "string", describe: "Substring search across fields" },
        limit: { type: "string", describe: "Max results (default 20; 0 = all)" },
        offset: { type: "string", describe: "Skip the first N results" },
        var: { type: "string", array: true, describe: "Prompt argument k=v (repeatable)" },
        data: { type: "string", describe: "Prompt arguments as JSON, or - for stdin" },
        "data-file": { type: "string", describe: "Read prompt arguments from a file" },
        "policies-path": { type: "string", describe: "Folder of per-spec policy JSON files" },
      }),
    handler: () => promptsCmd(rest),
  },
  {
    command: ["search <query..>", "grep <query..>"],
    describe: "Search operations across registered specs",
    builder: (y: Argv) =>
      y
        .positional("query", { type: "string", describe: "Search text or glob pattern" })
        .option("spec", { type: "string", describe: "Spec name or comma-separated set" })
        .option("limit", { type: "string", describe: "Max matches (default 20; 0 = all)" })
        .option("offset", { type: "string", describe: "Skip the first N matches" }),
    handler: () => searchCmd(rest),
  },
  {
    command: "usage [name]",
    describe: "Show recorded usage",
    builder: (y: Argv) =>
      y.positional("name", { type: "string", describe: "Spec name for ranked operations" }),
    handler: () => usageCmd(rest),
  },
  {
    command: "add <name>",
    describe: "Register a spec in the registry",
    builder: (y: Argv) =>
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
    builder: (y: Argv) =>
      y
        .option("compact", { type: "string", describe: "Set false to show full entry config" })
        .option("filter", { type: "string", describe: "Substring search on name or description" }),
    handler: () => specsCmd(rest),
  },
  {
    command: "remove <name>",
    describe: "Delete a spec from the registry",
    builder: (y: Argv) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("remove", rest),
  },
  {
    command: "enable <name>",
    describe: "Enable a disabled spec",
    builder: (y: Argv) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("enable", rest),
  },
  {
    command: "disable <name>",
    describe: "Disable a spec without removing it",
    builder: (y: Argv) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("disable", rest),
  },
  {
    command: "refresh <name>",
    describe: "Force re-fetch and update the cache",
    builder: (y: Argv) => y.positional("name", { type: "string", describe: "Registry name" }),
    handler: () => registryMutate("refresh", rest),
  },
  {
    command: "auth <name>",
    describe: "Re-authenticate or revoke an OAuth MCP spec",
    builder: (y: Argv) =>
      y
        .positional("name", { type: "string", describe: "Registry name" })
        .option("revoke", { type: "boolean", describe: "Clear the stored OAuth token" }),
    handler: () => authCmd(rest),
  },
  {
    command: ["config [action] [key] [value]", "cfg [action] [key] [value]"],
    describe: "Get, set, or unset persisted config",
    builder: (y: Argv) =>
      y
        .positional("action", { type: "string", choices: ["get", "show", "set", "unset"] })
        .positional("key", { type: "string" })
        .positional("value", { type: "string" }),
    handler: () => configCmd(rest),
  },
  {
    command: "policy [action] [id]",
    describe: "List, add, show, or remove call-blocking policy rules",
    builder: (y: Argv) =>
      y
        .positional("action", {
          type: "string",
          choices: ["list", "add", "show", "remove", "clear"],
        })
        .positional("id", { type: "string", describe: "Rule id" })
        .option("data", { type: "string", describe: "Rule JSON object" })
        .option("id", { type: "string", describe: "Rule id" })
        .option("tool", { type: "string", describe: "Tool or operation glob" })
        .option("spec", { type: "string", describe: "Limit rule to this spec name (glob)" })
        .option("message", { type: "string", describe: "Error message when blocked" })
        .option("when", { type: "string", array: true, describe: "Arg matcher key.op=value" })
        .option("local", { type: "boolean", describe: "Use project .spec-cli/policy.json" })
        .option("policies-path", {
          type: "string",
          describe: "Folder of per-spec policy JSON files",
        }),
    handler: () => policyCmd(rest),
  },
  {
    command: "validate <source>",
    describe: "Check an OpenAPI spec for errors",
    builder: (y: Argv) =>
      y.positional("source", { type: "string", describe: "OpenAPI file or URL" }),
    handler: () => validateSpec(rest),
  },
  {
    command: "import <file>",
    describe: "Bulk-register MCP servers from mcp.json",
    builder: (y: Argv) =>
      y.positional("file", { type: "string", describe: "mcp.json or Claude Desktop config" }),
    handler: () => importCmd(rest),
  },
  {
    command: "skill [sub]",
    describe: "Manage the bundled agent skill",
    builder: (y: Argv) =>
      y
        .positional("sub", { type: "string", choices: ["install", "path"] })
        .option("install", { type: "boolean" })
        .option("path", { type: "boolean" }),
    handler: () => skillCmd(rest),
  },
];

function isHelpRequest(args: string[]): boolean {
  return !args[0] || args[0] === "help" || args.includes("--help") || args.includes("-h");
}

function isVersionRequest(args: string[]): boolean {
  return args.includes("--version") || args.includes("-v");
}

export async function run(argv: string[]): Promise<void> {
  if (!process.env.SPEC_HOME) migrateLegacyHome();
  loadDotenv();
  sweepCache();

  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--format" && i + 1 < argv.length) setFormat(argv[++i]);
    else if (arg.startsWith("--format=")) setFormat(arg.slice(9));
    else if (arg === "--max-bytes" && i + 1 < argv.length) setMaxStdout(argv[++i]);
    else if (arg.startsWith("--max-bytes=")) setMaxStdout(arg.slice(12));
    else args.push(arg);
  }

  if (isHelpRequest(args)) {
    console.log(commandHelp(args[0] === "help" ? args[1] : args[0]));
    return;
  }

  if (isVersionRequest(args)) {
    console.log(VERSION);
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
    err((e as Error).message);
    process.exit(1);
  }
}

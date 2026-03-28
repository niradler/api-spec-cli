import { parseArgs, parseKV } from "../args.js";
import { getRegistry, saveRegistry } from "../registry.js";
import { out } from "../output.js";

export async function addCmd(args) {
  const { flags, positional } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error(
    "Usage: spec add <name> --openapi <url> | --graphql <url> | --mcp-http <url> | --mcp-sse <url> | --mcp-stdio \"<cmd>\""
  );
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Spec name must contain only letters, numbers, hyphens, and underscores.");
  }

  const registry = getRegistry();
  if (registry.find((e) => e.name === name)) {
    throw new Error(`Spec '${name}' already exists. Run 'spec remove ${name}' first.`);
  }

  const entry = { name, enabled: true };

  if (flags.description) entry.description = flags.description;

  if (flags.openapi) {
    entry.type = "openapi";
    entry.source = flags.openapi;
    entry.config = {
      baseUrl: flags["base-url"] || null,
      auth: flags.auth || null,
      headers: parseKV(flags.header),
    };
  } else if (flags.graphql) {
    entry.type = "graphql";
    entry.source = flags.graphql;
    entry.config = {
      auth: flags.auth || null,
      headers: parseKV(flags.header),
    };
  } else if (flags["mcp-stdio"]) {
    const raw = flags["mcp-stdio"];
    const parts = (raw.trim() ? raw.match(/(?:[^\s"]+|"[^"]*")+/g) : null)?.map((p) => p.replace(/^"|"$/g, ""));
    if (!parts?.length) throw new Error("--mcp-stdio requires a non-empty command string");
    entry.type = "mcp";
    entry.transport = "stdio";
    entry.command = parts[0];
    entry.args = parts.slice(1);
    if (flags.cwd) entry.cwd = flags.cwd;
    entry.config = { env: parseKV(flags.env) };
  } else if (flags["mcp-sse"]) {
    entry.type = "mcp";
    entry.transport = "sse";
    entry.url = flags["mcp-sse"];
    entry.config = { headers: parseKV(flags.header) };
  } else if (flags["mcp-http"]) {
    entry.type = "mcp";
    entry.transport = "streamable-http";
    entry.url = flags["mcp-http"];
    entry.config = { headers: parseKV(flags.header) };
  } else {
    throw new Error(
      "Specify a source: --openapi <url>, --graphql <url>, --mcp-http <url>, --mcp-sse <url>, or --mcp-stdio \"<cmd>\""
    );
  }

  // Tool filtering (MCP only)
  if (entry.type === "mcp") {
    const allowed = flags["allow-tool"];
    const disabled = flags["disable-tool"];
    if (allowed?.length) entry.config.allowedTools = allowed;
    if (disabled?.length) entry.config.disabledTools = disabled;
  }

  registry.push(entry);
  saveRegistry(registry);
  out({ ok: true, name, type: entry.type, transport: entry.transport });
}

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { parseArgs } from "../args.js";
import { addCmd } from "./add.js";
import { out } from "../output.js";

function quote(part) {
  return /\s/.test(part) ? `"${part}"` : part;
}

function registryName(name) {
  const cleaned = String(name)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) throw new Error(`Cannot derive a spec name from '${name}'`);
  return cleaned;
}

function addArgsForServer(name, server) {
  const args = [registryName(name)];
  const command = server.command;
  const url = server.url;
  if (command) {
    const cmd = [command, ...(server.args || [])].map(quote).join(" ");
    args.push("--mcp-stdio", cmd);
    for (const [key, value] of Object.entries(server.env || {})) {
      args.push("--env", `${key}=${value}`);
    }
    if (server.cwd) args.push("--cwd", server.cwd);
    return args;
  }
  if (url) {
    const sse = server.type === "sse" || server.transport === "sse";
    args.push(sse ? "--mcp-sse" : "--mcp-http", url);
    for (const [key, value] of Object.entries(server.headers || {})) {
      args.push("--header", `${key}=${value}`);
    }
    return args;
  }
  throw new Error(`Server '${name}' has no command or url`);
}

export function serversFromConfig(data) {
  const servers = data?.mcpServers || data?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  return servers;
}

export async function importCmd(args) {
  const { positional } = parseArgs(args);
  const file = positional[0];
  if (!file) throw new Error("Usage: spec import <file>");
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  let data;
  try {
    data = JSON.parse(readFileSync(abs, "utf-8"));
  } catch {
    throw new Error(`Invalid JSON: ${abs}`);
  }
  const servers = serversFromConfig(data);
  if (!servers) throw new Error("No mcpServers or servers object in file");

  const imported = [];
  for (const [name, server] of Object.entries(servers)) {
    await addCmd(addArgsForServer(name, server), { skipProbe: true });
    imported.push(registryName(name));
  }
  out({ ok: true, imported, count: imported.length });
}

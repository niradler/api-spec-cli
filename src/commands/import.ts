import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "../args.ts";
import { createSpecClient } from "../client.ts";
import { out } from "../output.ts";
import type { SpecSource, StringMap } from "../types.ts";

export interface McpServerConfig {
  command?: string;
  args?: unknown[];
  env?: Record<string, unknown>;
  cwd?: string;
  url?: string;
  type?: string;
  transport?: string;
  headers?: Record<string, unknown>;
}

function stringMap(values: Record<string, unknown> = {}): StringMap {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value)]));
}

export function registryName(name: string): string {
  const cleaned = String(name)
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) throw new Error(`Cannot derive a spec name from '${name}'`);
  return cleaned;
}

export function sourceFromServer(name: string, server: McpServerConfig): SpecSource {
  if (server.command)
    return {
      type: "stdio",
      command: server.command,
      args: (server.args || []).map(String),
      env: stringMap(server.env),
      ...(server.cwd ? { cwd: server.cwd } : {}),
    };
  if (server.url)
    return {
      type: server.type === "sse" || server.transport === "sse" ? "sse" : "http",
      url: server.url,
      headers: stringMap(server.headers),
    };
  throw new Error(`Server '${name}' has no command or url`);
}

export function serversFromConfig(data: unknown): Record<string, McpServerConfig> | null {
  const config = data as { mcpServers?: unknown; servers?: unknown } | null;
  const servers = config?.mcpServers || config?.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  return servers as Record<string, McpServerConfig>;
}

export async function importCmd(args: string[]): Promise<void> {
  const file = parseArgs(args).positional[0];
  if (!file) throw new Error("Usage: spec import <file>");
  const abs = resolve(file);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(abs, "utf-8"));
  } catch {
    throw new Error(`Invalid JSON: ${abs}`);
  }
  const servers = serversFromConfig(data);
  if (!servers) throw new Error("No mcpServers or servers object in file");

  const { specs } = createSpecClient({ interactiveAuth: true });
  const imported = Object.entries(servers).map(
    ([name, server]) => specs.add(registryName(name), sourceFromServer(name, server)).name
  );
  out({ ok: true, imported, count: imported.length });
}

import { parseArgs } from "../args.ts";
import { createSpecClient, type AddResult, type SpecClient } from "../client.ts";
import { out } from "../output.ts";
import { hasHeader } from "../secrets.ts";
import { SOURCE_USAGE, assertSpecName, sourceFromFlags } from "../sources.ts";

export async function addCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  const name = positional[0];
  if (!name)
    throw new Error(
      'Usage: spec add <name> --openapi <url> | --graphql <url> | --mcp-http <url> | --mcp-sse <url> | --mcp-stdio "<cmd>"'
    );
  assertSpecName(name);
  const source = sourceFromFlags(flags);
  if (!source) throw new Error(SOURCE_USAGE);
  const client = createSpecClient({ interactiveAuth: true });
  const added = client.specs.add(name, source);
  await probeAndAuth(client, added);
  out({
    ok: true,
    name,
    section: added.section,
    type: added.type,
    ...(added.overwritten ? { overwritten: true } : {}),
  });
}

async function probeAndAuth(client: SpecClient, { name, entry }: AddResult): Promise<void> {
  if (entry._section !== "mcp" || entry.type === "stdio") return;
  if (hasHeader(entry.headers ?? {}, "authorization")) return;
  try {
    const { flow } = await client.specs.authorize(name);
    if (flow === "none_required") process.stderr.write(`Connected (no auth required).\n`);
    else if (flow === "browser") process.stderr.write(`Authorization complete for '${name}'.\n`);
  } catch (e) {
    process.stderr.write(
      `Could not reach server: ${(e as Error).message}\nRun 'spec auth ${name}' after the server is available.\n`
    );
    process.exitCode = 1;
  }
}

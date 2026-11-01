import { readFileSync } from "node:fs";
import { flagString, parseArgs, parseKV, type Flags } from "../args.ts";
import { executeOperation, type CallRequest } from "../execute.ts";
import { out } from "../output.ts";
import { applyPoliciesPath } from "../policy.ts";
import { configOptionsFromFlags, resolveSpec } from "../resolve.ts";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8").trim();
}

export async function callData(flags: Flags): Promise<string | undefined> {
  let data = flagString(flags, "data");
  const file = flagString(flags, "data-file");
  if (file && !data) data = readFileSync(file, "utf-8").trim();
  return data === "-" ? await readStdin() : data;
}

export async function callOperation(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  applyPoliciesPath(flags);
  const target = positional[0];
  if (!target)
    throw new Error(
      "Usage: spec call <operation> [--spec <name> | --openapi <url> | ...] [--data '{}' | --data -] [--var k=v] [--header k=v]"
    );
  const request: CallRequest = {
    ...configOptionsFromFlags(flags),
    data: await callData(flags),
    vars: parseKV(flags.var),
    query: parseKV(flags.query),
    method: flagString(flags, "method"),
  };
  const { spec, entry } = await resolveSpec(flags);
  const payload = await executeOperation(spec, entry, target, request);
  out(payload);
  if ("isError" in payload && payload.isError) process.exit(1);
}

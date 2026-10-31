import { parseArgs } from "../args.ts";
import { createSpecClient } from "../client.ts";
import { out } from "../output.ts";

export async function authCmd(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error("Usage: spec auth <name> [--revoke]");
  const { specs } = createSpecClient();
  if ("revoke" in flags) {
    specs.revoke(name);
    out({ ok: true, name, revoked: true });
    return;
  }
  const { flow } = await specs.authorize(name);
  out({ ok: true, name, flow });
}

import { flagString, parseArgs, parseKV, parseLimit, parseOffset } from "../args.ts";
import { getPrompt } from "../execute.ts";
import { listPrompts } from "../mcp-features.ts";
import { out } from "../output.ts";
import { applyPoliciesPath } from "../policy.ts";
import { configOptionsFromFlags, resolveSpec } from "../resolve.ts";
import { callData } from "./call.ts";

export async function promptsCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  applyPoliciesPath(flags);
  const { spec, entry } = await resolveSpec(flags);
  const target = positional[0];
  if (!target)
    return out(
      listPrompts(spec, {
        filter: flagString(flags, "filter"),
        offset: parseOffset(flags),
        limit: parseLimit(flags),
      })
    );
  out(
    await getPrompt(spec, entry, target, {
      ...configOptionsFromFlags(flags),
      data: await callData(flags),
      vars: parseKV(flags.var),
    })
  );
}

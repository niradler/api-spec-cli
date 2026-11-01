import { parseArgs, parseKV } from "../args.ts";
import { readResource } from "../execute.ts";
import { listResources } from "../mcp-features.ts";
import { out } from "../output.ts";
import { applyPoliciesPath } from "../policy.ts";
import { configOptionsFromFlags, resolveSpec } from "../resolve.ts";

export async function resourcesCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  applyPoliciesPath(flags);
  const { spec, entry } = await resolveSpec(flags);
  const target = positional[0];
  if (!target) return out(listResources(spec));
  out(
    await readResource(spec, entry, target, {
      ...configOptionsFromFlags(flags),
      vars: parseKV(flags.var),
    })
  );
}

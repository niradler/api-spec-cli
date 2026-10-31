import { flagString, parseArgs, parseLimit, parseOffset } from "../args.ts";
import { listOperations as list } from "../operations.ts";
import { out } from "../output.ts";
import { resolveSpec } from "../resolve.ts";
import { getUsage } from "../usage.ts";

export async function listOperations(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const { spec } = await resolveSpec(flags);
  const name = flagString(flags, "spec");
  out(
    list(spec, {
      filter: flagString(flags, "filter"),
      compact: flags.compact !== "false",
      tag: flagString(flags, "tag"),
      offset: parseOffset(flags),
      limit: parseLimit(flags),
      top: parseInt(flagString(flags, "top") ?? "") || 0,
      usage: name ? getUsage(name) : {},
    })
  );
}

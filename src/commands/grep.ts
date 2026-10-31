import { flagString, parseArgs, parseLimit, parseOffset } from "../args.ts";
import { createSpecClient } from "../client.ts";
import { out } from "../output.ts";

export async function grepCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  const pattern = positional[0];
  if (!pattern)
    throw new Error(
      "Usage: spec grep <pattern> [--spec <name>] [--limit N] [--offset N]\n" +
        "  Glob patterns: * matches anything, ? matches one char\n" +
        "  Plain text: substring match across name and description"
    );
  out(
    await createSpecClient().operations.grep(pattern, {
      spec: flagString(flags, "spec"),
      offset: parseOffset(flags),
      limit: parseLimit(flags),
    })
  );
}

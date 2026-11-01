import { flagString, parseArgs, parseLimit, parseOffset } from "../args.ts";
import { createSpecClient } from "../client.ts";
import { out } from "../output.ts";

export async function searchCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  const query = positional.join(" ");
  if (!query)
    throw new Error(
      "Usage: spec search <query> [--spec <name>] [--limit N] [--offset N]\n" +
        "  Text: ranked full-text search over names, paths, summaries, descriptions and tags\n" +
        "  Glob: * matches anything, ? matches one char"
    );
  out(
    await createSpecClient({ interactiveAuth: true }).operations.search(query, {
      spec: flagString(flags, "spec")
        ?.split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      offset: parseOffset(flags),
      limit: parseLimit(flags),
    })
  );
}

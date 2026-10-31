import { parseArgs } from "../args.ts";
import { describeOperation } from "../operations.ts";
import { out } from "../output.ts";
import { resolveSpec } from "../resolve.ts";

export async function showOperation(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  const target = positional[0];
  if (!target)
    throw new Error(
      "Usage: spec show <operationId-or-path> [--spec <name> | --openapi <url> | ...]"
    );
  const { spec } = await resolveSpec(flags);
  out(describeOperation(spec, target));
}

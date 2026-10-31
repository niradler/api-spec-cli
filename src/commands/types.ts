import { parseArgs } from "../args.ts";
import { describeType, listTypes } from "../operations.ts";
import { out } from "../output.ts";
import { resolveSpec } from "../resolve.ts";

export async function typesCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);
  const { spec } = await resolveSpec(flags);
  const target = positional[0];
  out(target ? describeType(spec, target) : listTypes(spec));
}

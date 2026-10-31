import { parseArgs } from "../args.ts";
import { out } from "../output.ts";
import { allUsage, topOperations } from "../usage.ts";

export async function usageCmd(args: string[]): Promise<void> {
  const name = parseArgs(args).positional[0];
  out(name ? { spec: name, operations: topOperations(name, Infinity) } : { usage: allUsage() });
}

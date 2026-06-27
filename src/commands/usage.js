import { out } from "../output.js";
import { parseArgs } from "../args.js";
import { allUsage, topOperations } from "../usage.js";

export async function usageCmd(args) {
  const { positional } = parseArgs(args);
  const specName = positional[0];

  if (specName) {
    const operations = topOperations(specName, Infinity);
    out({ spec: specName, operations });
  } else {
    out({ usage: allUsage() });
  }
}

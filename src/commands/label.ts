import { parseArgs } from "../args.ts";
import { createSpecClient } from "../client.ts";
import { out } from "../output.ts";

export async function labelCmd(args: string[]): Promise<void> {
  const [action, name, ...labels] = parseArgs(args).positional;
  if ((action !== "add" && action !== "remove") || !name || labels.length === 0)
    throw new Error("Usage: spec label add|remove <spec> <label...>");
  const { specs } = createSpecClient({ interactiveAuth: true });
  const result =
    action === "add" ? specs.addLabels(name, labels) : specs.removeLabels(name, labels);
  out({ ok: true, spec: name, labels: result });
}

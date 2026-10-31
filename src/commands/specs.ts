import { flagString, parseArgs } from "../args.ts";
import { createSpecClient } from "../client.ts";
import { out } from "../output.ts";

export type RegistryAction = "remove" | "enable" | "disable" | "refresh";

export async function specsCmd(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const specs = createSpecClient({ interactiveAuth: true }).specs.list({
    filter: flagString(flags, "filter"),
    compact: flags.compact !== "false",
  });
  out({ specs });
}

export async function registryMutate(action: RegistryAction, args: string[]): Promise<void> {
  const name = parseArgs(args).positional[0];
  if (!name) throw new Error(`Usage: spec ${action} <name>`);
  const { specs } = createSpecClient({ interactiveAuth: true });
  switch (action) {
    case "remove":
      specs.remove(name);
      out({ ok: true, removed: name });
      return;
    case "enable":
      specs.enable(name);
      out({ ok: true, enabled: name });
      return;
    case "disable":
      specs.disable(name);
      out({ ok: true, disabled: name });
      return;
    case "refresh": {
      const { type, count } = await specs.refresh(name);
      out({ ok: true, refreshed: name, type, count });
      return;
    }
    default:
      throw new Error(`Unknown registry action: ${action}`);
  }
}

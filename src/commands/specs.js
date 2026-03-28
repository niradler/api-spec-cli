import { parseArgs } from "../args.js";
import { getRegistry, saveRegistry, getEntry, removeCachedSpec, saveCachedSpec } from "../registry.js";
import { resolveSpec } from "./load.js";
import { out } from "../output.js";

export async function specsCmd(args) {
  const { flags } = parseArgs(args);
  const compact = flags.compact !== "false";
  const registry = getRegistry();

  const specs = registry.map((e) => {
    if (compact) {
      return {
        name: e.name,
        type: e.type,
        transport: e.transport,
        description: e.description || null,
        enabled: e.enabled,
      };
    }
    return e;
  });

  out({ specs });
}

export async function registryMutate(action, args) {
  const { positional } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error(`Usage: spec ${action} <name>`);

  const registry = getRegistry();
  const idx = registry.findIndex((e) => e.name === name);
  if (idx === -1) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);

  if (action === "remove") {
    registry.splice(idx, 1);
    saveRegistry(registry);
    removeCachedSpec(name);
    out({ ok: true, removed: name });
    return;
  }

  if (action === "enable") {
    registry[idx].enabled = true;
    saveRegistry(registry);
    out({ ok: true, enabled: name });
    return;
  }

  if (action === "disable") {
    registry[idx].enabled = false;
    saveRegistry(registry);
    out({ ok: true, disabled: name });
    return;
  }

  if (action === "refresh") {
    const entry = registry[idx];
    if (!entry.enabled) throw new Error(`Spec '${name}' is disabled. Enable it first.`);
    const spec = await resolveSpec(entry);
    saveCachedSpec(name, spec);
    const count = spec.tools?.length ?? spec.operations?.length ?? 0;
    out({ ok: true, refreshed: name, type: spec.type, count });
    return;
  }

  throw new Error(`Unknown registry action: ${action}`);
}

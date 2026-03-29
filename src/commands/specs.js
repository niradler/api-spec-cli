import { parseArgs } from "../args.js";
import { getRegistry, saveRegistry, getEntry, removeCachedSpec, saveCachedSpec } from "../registry.js";
import { fetchSpec } from "./fetch.js";
import { out } from "../output.js";

function allEntries(registry) {
  const entries = [];
  for (const section of ["mcp", "openapi", "graphql"]) {
    for (const [name, entry] of Object.entries(registry[section] || {})) {
      entries.push({ ...entry, name, _section: section });
    }
  }
  return entries;
}

function findSection(registry, name) {
  for (const section of ["mcp", "openapi", "graphql"]) {
    if (registry[section]?.[name]) return section;
  }
  return null;
}

export async function specsCmd(args) {
  const { flags } = parseArgs(args);
  const compact = flags.compact !== "false";
  const registry = getRegistry();

  const specs = allEntries(registry).map((e) => {
    if (compact) {
      return {
        name: e.name,
        type: e.type,
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
  const section = findSection(registry, name);
  if (!section) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);

  if (action === "remove") {
    delete registry[section][name];
    saveRegistry(registry);
    removeCachedSpec(name);
    out({ ok: true, removed: name });
    return;
  }

  if (action === "enable") {
    registry[section][name].enabled = true;
    saveRegistry(registry);
    out({ ok: true, enabled: name });
    return;
  }

  if (action === "disable") {
    registry[section][name].enabled = false;
    saveRegistry(registry);
    out({ ok: true, disabled: name });
    return;
  }

  if (action === "refresh") {
    const entry = { ...registry[section][name], name, _section: section };
    if (!entry.enabled) throw new Error(`Spec '${name}' is disabled. Enable it first.`);
    const spec = await fetchSpec(entry);
    saveCachedSpec(name, spec);
    const count = spec.tools?.length ?? spec.operations?.length ?? 0;
    out({ ok: true, refreshed: name, type: spec.type, count });
    return;
  }

  throw new Error(`Unknown registry action: ${action}`);
}

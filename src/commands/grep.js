import { out } from "../output.js";
import { parseArgs } from "../args.js";
import { getRegistry, getEntry, getCachedSpec, saveCachedSpec, allEntries } from "../registry.js";
import { fetchSpec } from "./fetch.js";
import { matchGlob } from "../glob.js";

export async function grepCmd(args) {
  const { flags, positional } = parseArgs(args);
  const pattern = positional[0];
  if (!pattern)
    throw new Error(
      "Usage: spec grep <pattern> [--spec <name>]\n" +
        "  Glob patterns: * matches anything, ? matches one char\n" +
        "  Plain text: substring match across name and description"
    );

  const entries = flags.spec
    ? [getEntry(flags.spec)]
    : allEntries(getRegistry()).filter((e) => e.enabled);

  if (entries.length === 0) throw new Error("No registered specs. Run 'spec add' first.");

  const results = [];

  for (const entry of entries) {
    let spec = getCachedSpec(entry.name);
    if (!spec) {
      spec = await fetchSpec(entry);
      saveCachedSpec(entry.name, spec);
    }

    const matches = [];

    if (spec.type === "mcp") {
      for (const tool of spec.tools) {
        const nameMatch = matchGlob(pattern, tool.name);
        const descMatch = tool.description && matchGlob(pattern, tool.description);
        if (nameMatch || descMatch) {
          matches.push({ id: tool.name, description: tool.description });
        }
      }
    } else if (spec.type === "openapi") {
      for (const op of spec.operations) {
        if (
          matchGlob(pattern, op.id) ||
          matchGlob(pattern, op.path) ||
          (op.summary && matchGlob(pattern, op.summary))
        ) {
          matches.push({ id: op.id, method: op.method, path: op.path });
        }
      }
    } else if (spec.type === "graphql") {
      for (const op of spec.operations) {
        if (matchGlob(pattern, op.name) || (op.description && matchGlob(pattern, op.description))) {
          matches.push({ id: op.name, kind: op.kind });
        }
      }
    }

    if (matches.length > 0) {
      results.push({ spec: entry.name, type: spec.type, matches });
    }
  }

  const total = results.reduce((s, r) => s + r.matches.length, 0);
  out({ pattern, total, results });
}

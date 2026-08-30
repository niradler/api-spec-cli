import { out } from "../output.js";
import { parseArgs, parseLimit, parseOffset } from "../args.js";
import { getRegistry, getEntry, getCachedSpec, saveCachedSpec, allEntries } from "../registry.js";
import { fetchSpec } from "./fetch.js";
import { matchGlob } from "../glob.js";

export async function grepCmd(args) {
  const { flags, positional } = parseArgs(args);
  const pattern = positional[0];
  if (!pattern)
    throw new Error(
      "Usage: spec grep <pattern> [--spec <name>] [--limit N] [--offset N]\n" +
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

  const limit = parseLimit(flags);
  const offset = parseOffset(flags);
  const flat = [];
  for (const row of results) {
    for (const match of row.matches) {
      flat.push({ spec: row.spec, type: row.type, match });
    }
  }
  const total = flat.length;
  let page = flat;
  if (offset > 0) page = page.slice(offset);
  if (limit > 0) page = page.slice(0, limit);

  const grouped = [];
  const index = new Map();
  for (const row of page) {
    if (!index.has(row.spec)) {
      const group = { spec: row.spec, type: row.type, matches: [] };
      index.set(row.spec, group);
      grouped.push(group);
    }
    index.get(row.spec).matches.push(row.match);
  }

  const payload = { pattern, total, showing: page.length, results: grouped };
  if (offset > 0) payload.offset = offset;
  if (limit > 0 && page.length < total) payload.limit = limit;
  out(payload);
}

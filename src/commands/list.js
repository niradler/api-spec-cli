import { out } from "../output.js";
import { parseArgs, parseLimit, parseOffset } from "../args.js";
import { resolveSpec } from "../resolve.js";
import { getUsage } from "../usage.js";

export async function listOperations(args) {
  const opts = parseArgs(args);
  const { flags } = opts;

  const { spec } = await resolveSpec(flags);

  const filter = flags.filter?.toLowerCase();
  const compact = flags.compact !== "false";
  const limit = parseLimit(flags);
  const offset = parseOffset(flags);
  const tag = flags.tag?.toLowerCase();
  const top = parseInt(flags.top) || 0;

  let operations;

  if (spec.type === "openapi") {
    let source = spec.operations;
    if (tag) {
      source = source.filter((op) => op.tags?.some((t) => t.toLowerCase().includes(tag)));
    }
    operations = source.map((op) =>
      compact
        ? { id: op.id, method: op.method, path: op.path }
        : {
            id: op.id,
            method: op.method,
            path: op.path,
            summary: op.summary,
            tags: op.tags,
            deprecated: op.deprecated,
          }
    );
  } else if (spec.type === "mcp") {
    operations = spec.tools.map((t) =>
      compact
        ? { id: t.name, description: t.description }
        : { id: t.name, description: t.description, inputSchema: t.inputSchema }
    );
  } else {
    // graphql
    operations = spec.operations.map((op) =>
      compact
        ? { id: op.name, kind: op.kind }
        : {
            id: op.name,
            kind: op.kind,
            description: op.description,
            args: op.args.map((a) => a.name),
            returnType: op.returnType,
            isDeprecated: op.isDeprecated,
          }
    );

    if (tag) {
      operations = operations.filter((op) => op.kind === tag);
    }
  }

  if (filter) {
    operations = operations.filter((op) => JSON.stringify(op).toLowerCase().includes(filter));
  }

  const total = operations.length;

  if (top > 0) {
    const usageMap = flags.spec ? getUsage(flags.spec) : {};
    operations = operations
      .map((op) => ({ op, count: usageMap[op.id]?.count ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .map(({ op }) => op)
      .slice(0, top);
  } else {
    if (offset > 0) operations = operations.slice(offset);
    if (limit > 0) operations = operations.slice(0, limit);
  }

  const payload = {
    type: spec.type,
    total,
    showing: operations.length,
    offset: offset || 0,
    operations,
  };
  if (limit > 0 && operations.length < total) payload.limit = limit;
  out(payload);
}

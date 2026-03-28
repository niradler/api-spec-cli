import { getSpec } from "../store.js";
import { out } from "../output.js";
import { parseArgs } from "../args.js";

export async function listOperations(args) {
  const spec = getSpec();
  if (!spec) throw new Error("No spec loaded. Run: spec load <file-or-url>");

  const opts = parseArgs(args);
  const filter = opts.flags.filter?.toLowerCase();
  const compact = opts.flags.compact !== "false"; // compact by default
  const limit = parseInt(opts.flags.limit) || 0;
  const offset = parseInt(opts.flags.offset) || 0;
  const tag = opts.flags.tag?.toLowerCase();

  let operations;

  if (spec.type === "openapi") {
    operations = spec.operations.map((op) =>
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

    // Filter by tag
    if (tag) {
      const fullOps = spec.operations;
      operations = operations.filter((_, i) =>
        fullOps[i].tags?.some((t) => t.toLowerCase().includes(tag))
      );
    }
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

    // Filter by kind (query/mutation/subscription)
    if (tag) {
      operations = operations.filter((op) => op.kind === tag);
    }
  }

  if (filter) {
    operations = operations.filter((op) => {
      const text = JSON.stringify(op).toLowerCase();
      return text.includes(filter);
    });
  }

  const total = operations.length;

  // Pagination
  if (offset > 0) {
    operations = operations.slice(offset);
  }
  if (limit > 0) {
    operations = operations.slice(0, limit);
  }

  out({
    type: spec.type,
    total,
    showing: operations.length,
    offset: offset || 0,
    operations,
  });
}

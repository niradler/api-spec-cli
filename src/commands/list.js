import { out } from "../output.js";
import { parseArgs } from "../args.js";
import { resolveSpec } from "../resolve.js";

export async function listOperations(args) {
  const opts = parseArgs(args);
  const { flags } = opts;

  const { spec } = await resolveSpec(flags);

  const filter = flags.filter?.toLowerCase();
  const compact = flags.compact !== "false";
  const limit = parseInt(flags.limit) || 0;
  const offset = parseInt(flags.offset) || 0;
  const tag = flags.tag?.toLowerCase();

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
    operations = operations.filter((op) =>
      JSON.stringify(op).toLowerCase().includes(filter)
    );
  }

  const total = operations.length;

  if (offset > 0) operations = operations.slice(offset);
  if (limit > 0)  operations = operations.slice(0, limit);

  out({
    type: spec.type,
    total,
    showing: operations.length,
    offset: offset || 0,
    operations,
  });
}

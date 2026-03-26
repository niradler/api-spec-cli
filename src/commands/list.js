import { getSpec } from "../store.js";
import { out } from "../output.js";
import { parseArgs } from "../args.js";

export async function listOperations(args) {
  const spec = getSpec();
  if (!spec) throw new Error("No spec loaded. Run: spec load <file-or-url>");

  const opts = parseArgs(args);
  const filter = opts.flags.filter?.toLowerCase();

  let operations;

  if (spec.type === "openapi") {
    operations = spec.operations.map((op) => ({
      id: op.id,
      method: op.method,
      path: op.path,
      summary: op.summary,
      tags: op.tags,
      deprecated: op.deprecated,
    }));
  } else {
    // graphql
    operations = spec.operations.map((op) => ({
      id: op.name,
      kind: op.kind,
      description: op.description,
      args: op.args.map((a) => a.name),
      returnType: op.returnType,
      isDeprecated: op.isDeprecated,
    }));
  }

  if (filter) {
    operations = operations.filter((op) => {
      const text = JSON.stringify(op).toLowerCase();
      return text.includes(filter);
    });
  }

  out({
    type: spec.type,
    count: operations.length,
    operations,
  });
}

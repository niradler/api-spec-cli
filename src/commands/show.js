import { getSpec } from "../store.js";
import { out } from "../output.js";

export async function showOperation(args) {
  const target = args[0];
  if (!target) throw new Error("Usage: spec show <operationId-or-path>");

  const spec = getSpec();
  if (!spec) throw new Error("No spec loaded. Run: spec load <file-or-url>");

  if (spec.type === "openapi") {
    showOpenAPI(spec, target);
  } else {
    showGraphQL(spec, target);
  }
}

function showOpenAPI(spec, target) {
  const lower = target.toLowerCase();

  // Match by operationId, path, or "METHOD path"
  const op = spec.operations.find((o) => {
    return (
      o.id.toLowerCase() === lower ||
      o.path.toLowerCase() === lower ||
      `${o.method.toLowerCase()} ${o.path.toLowerCase()}` === lower
    );
  });

  if (!op) {
    throw new Error(`Operation not found: ${target}. Run 'spec list' to see available operations.`);
  }

  const root = spec.raw || spec.components;

  // Resolve $ref in parameters, requestBody, and responses
  const resolved = {
    ...op,
    parameters: op.parameters.map((p) => resolveRef(p, root)),
    requestBody: op.requestBody ? resolveRequestBody(op.requestBody, root) : null,
    responses: resolveResponses(op.responses, root),
  };

  out(resolved);
}

function showGraphQL(spec, target) {
  const lower = target.toLowerCase();

  const op = spec.operations.find((o) => o.name.toLowerCase() === lower);

  if (!op) {
    throw new Error(`Operation not found: ${target}. Run 'spec list' to see available operations.`);
  }

  // Also find related types
  const relatedTypes = findRelatedTypes(op, spec.types);

  out({
    ...op,
    relatedTypes,
  });
}

function resolveRef(obj, root) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.$ref) {
    const path = obj.$ref.replace("#/", "").split("/");
    let resolved = root;
    for (const p of path) {
      resolved = resolved?.[p];
    }
    return resolved || obj;
  }
  return obj;
}

function resolveRequestBody(body, root) {
  if (!body) return null;
  const resolved = resolveRef(body, root);
  if (resolved?.content) {
    const result = { ...resolved, content: {} };
    for (const [mediaType, value] of Object.entries(resolved.content)) {
      result.content[mediaType] = {
        ...value,
        schema: resolveSchema(value.schema, root),
      };
    }
    return result;
  }
  return resolved;
}

function resolveResponses(responses, root) {
  if (!responses) return responses;
  const result = {};
  for (const [code, resp] of Object.entries(responses)) {
    const resolved = resolveRef(resp, root);
    if (resolved?.content) {
      result[code] = {
        ...resolved,
        content: {},
      };
      for (const [mediaType, value] of Object.entries(resolved.content)) {
        result[code].content[mediaType] = {
          ...value,
          schema: resolveSchema(value.schema, root),
        };
      }
    } else {
      result[code] = resolved;
    }
  }
  return result;
}

function resolveSchema(schema, root, depth = 0) {
  if (!schema || depth > 5) return schema;
  if (schema.$ref) {
    return resolveRef(schema, root);
  }
  if (schema.properties) {
    const result = { ...schema, properties: {} };
    for (const [key, val] of Object.entries(schema.properties)) {
      result.properties[key] = resolveSchema(val, root, depth + 1);
    }
    return result;
  }
  if (schema.items) {
    return { ...schema, items: resolveSchema(schema.items, root, depth + 1) };
  }
  return schema;
}

function findRelatedTypes(op, types) {
  const names = new Set();

  // Collect type names from args and return type
  function extractTypeNames(typeStr) {
    if (!typeStr) return;
    const cleaned = typeStr.replace(/[[\]!]/g, "");
    if (cleaned) names.add(cleaned);
  }

  extractTypeNames(op.returnType);
  for (const arg of op.args || []) {
    extractTypeNames(flattenType(arg.type));
  }

  // Filter out built-in scalar types
  const scalars = new Set(["String", "Int", "Float", "Boolean", "ID"]);
  return types
    .filter((t) => names.has(t.name) && !scalars.has(t.name))
    .map((t) => ({
      name: t.name,
      kind: t.kind,
      fields: t.fields?.map((f) => ({
        name: f.name,
        type: flattenType(f.type),
        description: f.description,
      })),
      enumValues: t.enumValues,
    }));
}

function flattenType(t) {
  if (!t) return null;
  if (t.name) return t.kind === "NON_NULL" ? `${t.name}!` : t.name;
  if (t.ofType) {
    const inner = flattenType(t.ofType);
    if (t.kind === "LIST") return `[${inner}]`;
    if (t.kind === "NON_NULL") return `${inner}!`;
    return inner;
  }
  return t.kind;
}

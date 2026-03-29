import { out } from "../output.js";
import { parseArgs } from "../args.js";
import { resolveSpec } from "../resolve.js";

export async function showOperation(args) {
  const { flags, positional } = parseArgs(args);
  const target = positional[0];
  if (!target) throw new Error("Usage: spec show <operationId-or-path> [--spec <name> | --openapi <url> | ...]");

  const { spec } = await resolveSpec(flags);

  if (spec.type === "openapi") {
    showOpenAPI(spec, target);
  } else if (spec.type === "mcp") {
    showMCP(spec, target);
  } else {
    showGraphQL(spec, target);
  }
}

function showOpenAPI(spec, target) {
  const lower = target.toLowerCase();

  const op = spec.operations.find((o) =>
    o.id.toLowerCase() === lower ||
    o.path.toLowerCase() === lower ||
    `${o.method.toLowerCase()} ${o.path.toLowerCase()}` === lower
  );

  if (!op) {
    throw new Error(`Operation not found: ${target}. Run 'spec list' to see available operations.`);
  }

  const root = spec.raw || spec.components;

  out({
    id: op.id,
    method: op.method,
    path: op.path,
    summary: op.summary,
    description: op.description,
    tags: op.tags,
    deprecated: op.deprecated,
    parameters: op.parameters.map((p) => {
      const resolved = resolveRef(p, root);
      return {
        name: resolved.name,
        in: resolved.in,
        required: resolved.required || false,
        type: resolved.schema?.type || null,
        format: resolved.schema?.format || undefined,
        description: resolved.description || undefined,
        enum: resolved.schema?.enum || undefined,
      };
    }),
    requestBody: op.requestBody ? resolveRequestBody(op.requestBody, root) : null,
    responses: resolveResponsesCompact(op.responses, root),
  });
}

function showMCP(spec, target) {
  const tool = spec.tools.find((t) => t.name.toLowerCase() === target.toLowerCase());
  if (!tool) {
    throw new Error(`Tool not found: ${target}. Run 'spec list' to see available tools.`);
  }
  out({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  });
}

function showGraphQL(spec, target) {
  const lower = target.toLowerCase();

  const op = spec.operations.find((o) => o.name.toLowerCase() === lower);

  if (!op) {
    throw new Error(`Operation not found: ${target}. Run 'spec list' to see available operations.`);
  }

  const relatedTypes = findRelatedTypes(op, spec.types);

  out({
    name: op.name,
    kind: op.kind,
    description: op.description,
    returnType: op.returnType,
    isDeprecated: op.isDeprecated,
    args: op.args?.map((a) => ({
      name: a.name,
      type: flattenType(a.type),
      required: a.type?.kind === "NON_NULL",
      description: a.description || undefined,
      defaultValue: a.defaultValue || undefined,
    })),
    relatedTypes,
  });
}

// --- Helpers ---

function resolveRef(obj, root) {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.$ref) {
    const path = obj.$ref.replace("#/", "").split("/");
    let resolved = root;
    for (const p of path) resolved = resolved?.[p];
    return resolved || obj;
  }
  return obj;
}

function resolveRequestBody(body, root) {
  if (!body) return null;
  const resolved = resolveRef(body, root);
  if (resolved?.content) {
    const jsonContent = resolved.content["application/json"];
    if (jsonContent) {
      return {
        description: resolved.description || undefined,
        required: resolved.required || undefined,
        schema: resolveSchema(jsonContent.schema, root),
      };
    }
    const [mediaType, value] = Object.entries(resolved.content)[0];
    return {
      description: resolved.description || undefined,
      required: resolved.required || undefined,
      mediaType,
      schema: resolveSchema(value.schema, root),
    };
  }
  return resolved;
}

function resolveResponsesCompact(responses, root) {
  if (!responses) return null;
  const result = {};
  for (const [code, resp] of Object.entries(responses)) {
    const resolved = resolveRef(resp, root);
    if (resolved?.content) {
      const jsonContent = resolved.content["application/json"];
      result[code] = jsonContent
        ? { description: resolved.description, schema: resolveSchema(jsonContent.schema, root) }
        : { description: resolved.description };
    } else {
      result[code] = { description: resolved.description };
    }
  }
  return result;
}

function resolveSchema(schema, root, depth = 0) {
  if (!schema || depth > 3) return schema;
  if (schema.$ref) return resolveSchema(resolveRef(schema, root), root, depth + 1);
  if (schema.properties) {
    const result = { type: schema.type, required: schema.required, properties: {} };
    for (const [key, val] of Object.entries(schema.properties)) {
      if (val.$ref) {
        result.properties[key] = { $ref: val.$ref.split("/").pop() };
      } else if (val.type === "array" && val.items?.$ref) {
        result.properties[key] = { type: "array", items: val.items.$ref.split("/").pop() };
      } else {
        const prop = { type: val.type };
        if (val.format) prop.format = val.format;
        if (val.enum) prop.enum = val.enum;
        if (val.description) prop.description = val.description;
        result.properties[key] = prop;
      }
    }
    return result;
  }
  if (schema.items) {
    if (schema.items.$ref) return { type: "array", items: schema.items.$ref.split("/").pop() };
    return { type: "array", items: resolveSchema(schema.items, root, depth + 1) };
  }
  return schema;
}

function findRelatedTypes(op, types) {
  const names = new Set();

  function extractTypeNames(typeStr) {
    if (!typeStr) return;
    const cleaned = typeStr.replace(/[[\]!]/g, "");
    if (cleaned) names.add(cleaned);
  }

  extractTypeNames(op.returnType);
  for (const arg of op.args || []) extractTypeNames(flattenType(arg.type));

  const scalars = new Set(["String", "Int", "Float", "Boolean", "ID"]);
  return types
    .filter((t) => names.has(t.name) && !scalars.has(t.name))
    .map((t) => {
      const result = { name: t.name, kind: t.kind };
      if (t.fields) result.fields = t.fields.map((f) => ({ name: f.name, type: flattenType(f.type) }));
      if (t.inputFields) result.inputFields = t.inputFields.map((f) => ({ name: f.name, type: flattenType(f.type) }));
      if (t.enumValues) result.enumValues = t.enumValues.map((e) => e.name);
      return result;
    });
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

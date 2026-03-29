import { out } from "../output.js";
import { parseArgs } from "../args.js";
import { resolveSpec } from "../resolve.js";

export async function typesCmd(args) {
  const { positional, flags } = parseArgs(args);
  const { spec } = await resolveSpec(flags);
  const target = positional[0];

  if (spec.type === "openapi") {
    showOpenAPISchema(spec, target, flags);
  } else {
    showGraphQLType(spec, target, flags);
  }
}

function showOpenAPISchema(spec, target, flags) {
  const schemas = spec.raw?.components?.schemas || spec.raw?.definitions || {};

  if (!target) {
    // List all schema names — just names, very compact
    const names = Object.keys(schemas);
    out({
      type: "openapi",
      count: names.length,
      schemas: names,
    });
    return;
  }

  // Find schema (case-insensitive)
  const lower = target.toLowerCase();
  const key = Object.keys(schemas).find((k) => k.toLowerCase() === lower);

  if (!key) {
    throw new Error(`Schema not found: ${target}. Run 'spec types' to list available schemas.`);
  }

  const schema = schemas[key];
  const root = spec.raw;

  // Resolve one level deep — don't recursively explode nested schemas
  const resolved = resolveSchemaCompact(schema, root);

  out({
    name: key,
    ...resolved,
  });
}

function showGraphQLType(spec, target, flags) {
  const scalars = new Set(["String", "Int", "Float", "Boolean", "ID"]);
  const userTypes = spec.types?.filter((t) => !t.name.startsWith("__") && !scalars.has(t.name)) || [];

  if (!target) {
    // List type names grouped by kind — compact
    const grouped = {};
    for (const t of userTypes) {
      if (!grouped[t.kind]) grouped[t.kind] = [];
      grouped[t.kind].push(t.name);
    }
    out({
      type: "graphql",
      count: userTypes.length,
      types: grouped,
    });
    return;
  }

  // Find specific type
  const lower = target.toLowerCase();
  const type = userTypes.find((t) => t.name.toLowerCase() === lower);

  if (!type) {
    throw new Error(`Type not found: ${target}. Run 'spec types' to list available types.`);
  }

  const result = {
    name: type.name,
    kind: type.kind,
    description: type.description || null,
  };

  if (type.fields) {
    result.fields = type.fields.map((f) => ({
      name: f.name,
      type: flattenType(f.type),
      args: f.args?.length > 0 ? f.args.map((a) => ({ name: a.name, type: flattenType(a.type) })) : undefined,
    }));
  }

  if (type.inputFields) {
    result.inputFields = type.inputFields.map((f) => ({
      name: f.name,
      type: flattenType(f.type),
      defaultValue: f.defaultValue || undefined,
    }));
  }

  if (type.enumValues) {
    result.enumValues = type.enumValues.map((e) => e.name);
  }

  out(result);
}

function resolveSchemaCompact(schema, root) {
  if (!schema) return schema;

  if (schema.$ref) {
    const path = schema.$ref.replace("#/", "").split("/");
    let resolved = root;
    for (const p of path) resolved = resolved?.[p];
    return resolveSchemaCompact(resolved, root);
  }

  const result = {};
  if (schema.type) result.type = schema.type;
  if (schema.description) result.description = schema.description;
  if (schema.required) result.required = schema.required;
  if (schema.enum) result.enum = schema.enum;

  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(schema.properties)) {
      if (val.$ref) {
        // Just show the type name, don't resolve
        const refName = val.$ref.split("/").pop();
        result.properties[key] = { $ref: refName };
      } else if (val.type === "array" && val.items?.$ref) {
        const refName = val.items.$ref.split("/").pop();
        result.properties[key] = { type: "array", items: refName };
      } else {
        result.properties[key] = { type: val.type || null };
        if (val.enum) result.properties[key].enum = val.enum;
        if (val.format) result.properties[key].format = val.format;
        if (val.description) result.properties[key].description = val.description;
      }
    }
  }

  if (schema.items) {
    if (schema.items.$ref) {
      result.items = schema.items.$ref.split("/").pop();
    } else {
      result.items = { type: schema.items.type };
    }
  }

  return result;
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

import { flattenType } from "./graphql.ts";
import { matchGlob } from "./glob.ts";
import type { SearchDocument } from "./search.ts";
import type {
  GraphqlOperation,
  GraphqlSpec,
  GraphqlType,
  McpTool,
  OpenApiOperation,
  OpenApiSpec,
  SpecDocument,
  SpecType,
} from "./types.ts";

type Raw = any;

export type SpecOperation = OpenApiOperation | GraphqlOperation | McpTool;

export interface ListOptions {
  filter?: string;
  compact?: boolean;
  tag?: string;
  offset?: number;
  limit?: number;
  top?: number;
  usage?: Record<string, { count: number }>;
}

export interface OperationSummary {
  id: string;
  [key: string]: unknown;
}

export interface OperationList {
  type: SpecType;
  total: number;
  showing: number;
  offset: number;
  operations: OperationSummary[];
  limit?: number;
}

export interface GrepMatch {
  id: string;
  description: string;
}

export interface SpecTypes {
  type: SpecType;
  count: number;
  schemas?: string[];
  types?: Record<string, string[]>;
}

const SUMMARY_MAX = 120;

const GRAPHQL_SCALARS = new Set(["String", "Int", "Float", "Boolean", "ID"]);

export function operations(spec: SpecDocument): SpecOperation[] {
  return spec.type === "mcp" ? spec.tools : spec.operations;
}

export function operationId(spec: SpecDocument, operation: SpecOperation): string {
  if (spec.type === "openapi") return (operation as OpenApiOperation).id;
  return (operation as McpTool | GraphqlOperation).name;
}

export function findOperation(
  spec: SpecDocument,
  target: string,
  { exact = false }: { exact?: boolean } = {}
): SpecOperation | undefined {
  const lower = target.toLowerCase();
  if (spec.type === "openapi") {
    return spec.operations.find((o) =>
      exact
        ? o.id === target
        : o.id.toLowerCase() === lower ||
          o.path.toLowerCase() === lower ||
          `${o.method.toLowerCase()} ${o.path.toLowerCase()}` === lower
    );
  }
  const candidates: (McpTool | GraphqlOperation)[] =
    spec.type === "mcp" ? spec.tools : spec.operations;
  return candidates.find((o) => (exact ? o.name === target : o.name.toLowerCase() === lower));
}

export function notFoundMessage(spec: SpecDocument, target: string): string {
  return spec.type === "mcp"
    ? `Tool not found: ${target}. Run 'spec list' to see available tools.`
    : `Operation not found: ${target}. Run 'spec list' to see available operations.`;
}

export function requireOperation(
  spec: SpecDocument,
  target: string,
  options: { exact?: boolean } = {}
): SpecOperation {
  const operation = findOperation(spec, target, options);
  if (!operation) throw new Error(notFoundMessage(spec, target));
  return operation;
}

function summarize(spec: SpecDocument, compact: boolean, tag?: string): OperationSummary[] {
  if (spec.type === "openapi") {
    const source = tag
      ? spec.operations.filter((op) => op.tags?.some((t) => t.toLowerCase().includes(tag)))
      : spec.operations;
    return source.map((op) =>
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
  }
  if (spec.type === "mcp") {
    return spec.tools.map((t) =>
      compact
        ? { id: t.name, description: t.description }
        : { id: t.name, description: t.description, inputSchema: t.inputSchema }
    );
  }
  const summaries = spec.operations.map((op) =>
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
  return tag ? summaries.filter((op) => op.kind === tag) : summaries;
}

export function listOperations(spec: SpecDocument, options: ListOptions = {}): OperationList {
  const filter = options.filter?.toLowerCase();
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 0;
  const top = options.top ?? 0;

  let items = summarize(spec, options.compact ?? true, options.tag?.toLowerCase());
  if (filter) items = items.filter((op) => JSON.stringify(op).toLowerCase().includes(filter));
  const total = items.length;

  if (top > 0) {
    const usage = options.usage ?? {};
    items = items
      .map((op) => ({ op, count: usage[op.id]?.count ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .map(({ op }) => op)
      .slice(0, top);
  } else {
    if (offset > 0) items = items.slice(offset);
    if (limit > 0) items = items.slice(0, limit);
  }

  const result: OperationList = {
    type: spec.type,
    total,
    showing: items.length,
    offset,
    operations: items,
  };
  if (top === 0 && limit > 0 && items.length < total) result.limit = limit;
  return result;
}

export function operationSummary(operation: SpecOperation): string {
  const text = ("summary" in operation && operation.summary) || operation.description || "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_MAX ? `${line.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : line;
}

export function grepMatch(operation: SpecOperation): GrepMatch {
  return {
    id: "path" in operation ? operation.id : operation.name,
    description: operationSummary(operation),
  };
}

function grepText(operation: SpecOperation): string[] {
  if ("path" in operation) return [operation.id, operation.path, operation.summary || ""];
  return [operation.name, operation.description || ""];
}

export function operationSearchDocument(id: string, operation: SpecOperation): SearchDocument {
  return {
    id,
    name: "path" in operation ? operation.id : operation.name,
    path:
      "path" in operation
        ? `${operation.method} ${operation.path}`
        : "kind" in operation
          ? operation.kind
          : "",
    summary: "summary" in operation ? operation.summary || "" : "",
    description: operation.description || "",
    tags: "tags" in operation ? (operation.tags || []).join(" ") : "",
  };
}

export function operationMatches(operation: SpecOperation, pattern: string): boolean {
  return grepText(operation).some((text) => text && matchGlob(pattern, text));
}

export function grepOperations(spec: SpecDocument, pattern: string): GrepMatch[] {
  return operations(spec)
    .filter((operation) => operationMatches(operation, pattern))
    .map(grepMatch);
}

export function describeOperation(spec: SpecDocument, target: string): Record<string, unknown> {
  const operation = requireOperation(spec, target);
  if (spec.type === "openapi") return describeOpenApi(spec, operation as OpenApiOperation);
  if (spec.type === "mcp") {
    const tool = operation as McpTool;
    return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  }
  return describeGraphql(spec, operation as GraphqlOperation);
}

function describeOpenApi(spec: OpenApiSpec, op: OpenApiOperation): Record<string, unknown> {
  const root: Raw = spec.raw || spec.components;
  return {
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
  };
}

function describeGraphql(spec: GraphqlSpec, op: GraphqlOperation): Record<string, unknown> {
  return {
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
    relatedTypes: findRelatedTypes(op, spec.types),
  };
}

function resolveRef(obj: Raw, root: Raw): Raw {
  if (!obj || typeof obj !== "object") return obj;
  if (obj.$ref) {
    let resolved = root;
    for (const p of obj.$ref.replace("#/", "").split("/")) resolved = resolved?.[p];
    return resolved || obj;
  }
  return obj;
}

function refName(ref: string): string | undefined {
  return ref.split("/").pop();
}

function resolveRequestBody(body: Raw, root: Raw): Raw {
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
    const [mediaType, value] = Object.entries(resolved.content)[0] as [string, Raw];
    return {
      description: resolved.description || undefined,
      required: resolved.required || undefined,
      mediaType,
      schema: resolveSchema(value.schema, root),
    };
  }
  return resolved;
}

function resolveResponsesCompact(responses: Raw, root: Raw): Raw {
  if (!responses) return null;
  const result: Record<string, unknown> = {};
  for (const [code, resp] of Object.entries(responses)) {
    const resolved = resolveRef(resp, root);
    const jsonContent = resolved?.content?.["application/json"];
    result[code] = jsonContent
      ? { description: resolved.description, schema: resolveSchema(jsonContent.schema, root) }
      : { description: resolved.description };
  }
  return result;
}

function resolveSchema(schema: Raw, root: Raw, depth = 0): Raw {
  if (!schema || depth > 3) return schema;
  if (schema.$ref) return resolveSchema(resolveRef(schema, root), root, depth + 1);
  if (schema.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries<Raw>(schema.properties)) {
      if (val.$ref) {
        properties[key] = { $ref: refName(val.$ref) };
      } else if (val.type === "array" && val.items?.$ref) {
        properties[key] = { type: "array", items: refName(val.items.$ref) };
      } else {
        const prop: Raw = { type: val.type };
        if (val.format) prop.format = val.format;
        if (val.enum) prop.enum = val.enum;
        if (val.description) prop.description = val.description;
        properties[key] = prop;
      }
    }
    return { type: schema.type, required: schema.required, properties };
  }
  if (schema.items) {
    if (schema.items.$ref) return { type: "array", items: refName(schema.items.$ref) };
    return { type: "array", items: resolveSchema(schema.items, root, depth + 1) };
  }
  return schema;
}

function graphqlTypeSummary(t: GraphqlType): Record<string, unknown> {
  const result: Record<string, unknown> = { name: t.name, kind: t.kind };
  if (t.fields) result.fields = t.fields.map((f) => ({ name: f.name, type: flattenType(f.type) }));
  if (t.inputFields)
    result.inputFields = t.inputFields.map((f) => ({ name: f.name, type: flattenType(f.type) }));
  if (t.enumValues) result.enumValues = t.enumValues.map((e) => e.name);
  return result;
}

function findRelatedTypes(op: GraphqlOperation, types: GraphqlType[]): Record<string, unknown>[] {
  const names = new Set<string>();
  const add = (typeStr: string | null) => {
    const cleaned = typeStr?.replace(/[[\]!]/g, "");
    if (cleaned) names.add(cleaned);
  };
  add(op.returnType);
  for (const arg of op.args || []) add(flattenType(arg.type));
  return types
    .filter((t) => names.has(t.name) && !GRAPHQL_SCALARS.has(t.name))
    .map(graphqlTypeSummary);
}

export function listTypes(spec: SpecDocument): SpecTypes {
  if (spec.type === "openapi") {
    const schemas = Object.keys(openApiSchemas(spec));
    return { type: "openapi", count: schemas.length, schemas };
  }
  const types: Record<string, string[]> = {};
  const userTypes = graphqlUserTypes(spec);
  for (const t of userTypes) (types[t.kind] ??= []).push(t.name);
  return { type: "graphql", count: userTypes.length, types };
}

export function describeType(spec: SpecDocument, target: string): Record<string, unknown> {
  const lower = target.toLowerCase();
  if (spec.type === "openapi") {
    const schemas = openApiSchemas(spec);
    const key = Object.keys(schemas).find((k) => k.toLowerCase() === lower);
    if (!key)
      throw new Error(`Schema not found: ${target}. Run 'spec types' to list available schemas.`);
    return { name: key, ...resolveSchemaCompact(schemas[key], spec.raw) };
  }

  const type = graphqlUserTypes(spec).find((t) => t.name.toLowerCase() === lower);
  if (!type)
    throw new Error(`Type not found: ${target}. Run 'spec types' to list available types.`);

  const result: Record<string, unknown> = {
    name: type.name,
    kind: type.kind,
    description: type.description || null,
  };
  if (type.fields) {
    result.fields = type.fields.map((f) => ({
      name: f.name,
      type: flattenType(f.type),
      args: f.args?.length
        ? f.args.map((a) => ({ name: a.name, type: flattenType(a.type) }))
        : undefined,
    }));
  }
  if (type.inputFields) {
    result.inputFields = type.inputFields.map((f) => ({
      name: f.name,
      type: flattenType(f.type),
      defaultValue: f.defaultValue || undefined,
    }));
  }
  if (type.enumValues) result.enumValues = type.enumValues.map((e) => e.name);
  return result;
}

function openApiSchemas(spec: OpenApiSpec): Record<string, Raw> {
  const raw: Raw = spec.raw;
  return raw?.components?.schemas || raw?.definitions || {};
}

function graphqlUserTypes(spec: SpecDocument): GraphqlType[] {
  const types = spec.type === "graphql" ? spec.types : [];
  return types?.filter((t) => !t.name.startsWith("__") && !GRAPHQL_SCALARS.has(t.name)) || [];
}

function resolveSchemaCompact(schema: Raw, root: Raw): Raw {
  if (!schema) return schema;
  if (schema.$ref) {
    let resolved = root;
    for (const p of schema.$ref.replace("#/", "").split("/")) resolved = resolved?.[p];
    return resolveSchemaCompact(resolved, root);
  }

  const result: Raw = {};
  if (schema.type) result.type = schema.type;
  if (schema.description) result.description = schema.description;
  if (schema.required) result.required = schema.required;
  if (schema.enum) result.enum = schema.enum;

  if (schema.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries<Raw>(schema.properties)) {
      if (val.$ref) {
        result.properties[key] = { $ref: refName(val.$ref) };
      } else if (val.type === "array" && val.items?.$ref) {
        result.properties[key] = { type: "array", items: refName(val.items.$ref) };
      } else {
        const prop: Raw = { type: val.type || null };
        if (val.enum) prop.enum = val.enum;
        if (val.format) prop.format = val.format;
        if (val.description) prop.description = val.description;
        result.properties[key] = prop;
      }
    }
  }

  if (schema.items) {
    result.items = schema.items.$ref ? refName(schema.items.$ref) : { type: schema.items.type };
  }

  return result;
}

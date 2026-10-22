function objectSchema(properties = {}, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function resolvePointer(value, root) {
  if (!value?.$ref) return value;
  if (!value.$ref.startsWith("#/")) throw new Error("External schema references are unsupported");
  return value.$ref
    .slice(2)
    .split("/")
    .reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
}

function jsonSchema(value, root, definitions, references) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => jsonSchema(item, root, definitions, references));
  if (value.$ref) {
    if (!references.has(value.$ref)) {
      const name = `schema${references.size}`;
      references.set(value.$ref, name);
      const resolved = resolvePointer(value, root);
      if (!resolved) throw new Error("Unresolved schema reference");
      definitions[name] = jsonSchema(resolved, root, definitions, references);
    }
    return { $ref: `#/$defs/${references.get(value.$ref)}` };
  }
  const result = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["nullable", "example", "xml", "discriminator", "$id"].includes(key))
      .map(([key, item]) => [key, jsonSchema(item, root, definitions, references)])
  );
  if (value.nullable && result.type) result.type = [result.type, "null"];
  return result;
}

function graphqlSchema(type, types, definitions) {
  if (type.kind === "NON_NULL")
    return graphqlNonNull(type.ofType || { ...type, kind: "SCALAR" }, types, definitions);
  return { anyOf: [graphqlNonNull(type, types, definitions), { type: "null" }] };
}

function graphqlNonNull(type, types, definitions) {
  if (type.kind === "LIST")
    return { type: "array", items: graphqlSchema(type.ofType, types, definitions) };
  const scalar = {
    Int: "integer",
    Float: "number",
    Boolean: "boolean",
    String: "string",
    ID: "string",
  }[type.name];
  if (scalar) return { type: scalar };
  const named = types.find((item) => item.name === type.name);
  if (named?.kind === "ENUM")
    return { type: "string", enum: named.enumValues.map((item) => item.name) };
  if (named?.kind === "INPUT_OBJECT") {
    if (!Object.hasOwn(definitions, named.name)) {
      definitions[named.name] = {};
      definitions[named.name] = graphqlArguments(named.inputFields || [], types, definitions);
    }
    return { $ref: `#/$defs/${named.name}` };
  }
  return {};
}

function graphqlArguments(args, types, definitions) {
  return objectSchema(
    Object.fromEntries(args.map((arg) => [arg.name, graphqlSchema(arg.type, types, definitions)])),
    args
      .filter((arg) => arg.type.kind === "NON_NULL" && arg.defaultValue == null)
      .map((arg) => arg.name)
  );
}

export function operationQuery(spec, operation, query = {}) {
  const parameters = [
    ...(spec.raw?.paths?.[operation.path]?.parameters || []),
    ...(operation.parameters || []),
  ].map((item) => resolvePointer(item, spec.raw));
  return Object.entries(query).flatMap(([name, value]) => {
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      throw new Error("Object query serialization is unsupported");
    const parameter = parameters.findLast((item) => item?.in === "query" && item.name === name);
    const style = parameter?.style || "form";
    if (!Array.isArray(value)) return [[name, String(value)]];
    if (style === "form" && parameter?.explode !== false)
      return value.map((item) => [name, String(item)]);
    const separator = { form: ",", spaceDelimited: " ", pipeDelimited: "|" }[style];
    if (!separator) throw new Error("Unsupported query serialization");
    return [[name, value.join(separator)]];
  });
}

export function operationSchema(spec, operation) {
  if (spec.type === "mcp") return operation.inputSchema || objectSchema();
  if (spec.type === "graphql") {
    const definitions = {};
    return {
      ...graphqlArguments(operation.args || [], spec.types || [], definitions),
      $defs: definitions,
    };
  }
  const root = spec.raw;
  const definitions = {};
  const references = new Map();
  const properties = {};
  const required = [];
  const pathItem = root?.paths?.[operation.path];
  const parameters = [...(pathItem?.parameters || []), ...(operation.parameters || [])].map(
    (item) => resolvePointer(item, root)
  );
  for (const location of ["path", "query"]) {
    const selected = parameters.filter((parameter) => parameter?.in === location);
    if (!selected.length) continue;
    const fields = Object.fromEntries(
      selected.map((parameter) => [
        parameter.name,
        jsonSchema(
          parameter.schema || { type: parameter.type || "string" },
          root,
          definitions,
          references
        ),
      ])
    );
    const requiredFields = selected
      .filter((parameter) => parameter.required || location === "path")
      .map((parameter) => parameter.name);
    properties[location] = objectSchema(fields, requiredFields);
    if (requiredFields.length) required.push(location);
  }
  const body = resolvePointer(operation.requestBody, root);
  const bodySchema =
    body?.content?.["application/json"]?.schema ||
    parameters.find((parameter) => parameter?.in === "body")?.schema;
  if (bodySchema) {
    properties.body = jsonSchema(bodySchema, root, definitions, references);
    if (
      body?.required ||
      parameters.some((parameter) => parameter?.in === "body" && parameter.required)
    )
      required.push("body");
  }
  return { ...objectSchema(properties, required), $defs: definitions };
}

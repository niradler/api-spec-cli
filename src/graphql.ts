import type { GraphqlOperation, GraphqlType, GraphqlTypeRef } from "./types.ts";

export function flattenType(type: GraphqlTypeRef | string | null | undefined): string | null {
  if (!type) return null;
  if (typeof type === "string") return type;
  if (type.name) return type.kind === "NON_NULL" ? `${type.name}!` : type.name;
  if (type.ofType) {
    const inner = flattenType(type.ofType);
    if (type.kind === "LIST") return `[${inner}]`;
    if (type.kind === "NON_NULL") return `${inner}!`;
    return inner;
  }
  return type.kind;
}

export function baseTypeName(type: GraphqlTypeRef | string | null | undefined): string | undefined {
  return flattenType(type)?.replace(/[[\]!]/g, "");
}

export function buildGraphqlQuery(operation: GraphqlOperation, types: GraphqlType[] = []): string {
  const args = operation.args || [];
  const argsStr =
    args.length > 0
      ? `(${args.map((a) => `$${a.name}: ${flattenType(a.type)}${a.defaultValue != null ? ` = ${a.defaultValue}` : ""}`).join(", ")})`
      : "";
  const passArgs =
    args.length > 0 ? `(${args.map((a) => `${a.name}: $${a.name}`).join(", ")})` : "";

  const returnType = types.find((t) => t.name === baseTypeName(operation.returnType));
  let fields = "";
  if (returnType?.fields) {
    const scalarFields = returnType.fields
      .filter((f) => {
        const t = types.find((candidate) => candidate.name === baseTypeName(f.type));
        return !t || t.kind === "SCALAR" || t.kind === "ENUM";
      })
      .map((f) => f.name);
    if (scalarFields.length > 0) fields = ` { ${scalarFields.join(" ")} }`;
  }

  const keyword = operation.kind === "mutation" ? "mutation" : "query";
  return `${keyword}${argsStr} { ${operation.name}${passArgs}${fields} }`;
}

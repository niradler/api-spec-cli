import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { parseArgs } from "../args.ts";
import { out } from "../output.ts";

type Raw = any;

interface Issue {
  path: string;
  message: string;
}

export async function validateSpec(args: string[]): Promise<void> {
  const { positional } = parseArgs(args);
  const source = positional[0];
  if (!source) throw new Error("Usage: spec validate <file-or-url>");

  const isUrl = source.startsWith("http://") || source.startsWith("https://");

  let text;
  if (isUrl) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    text = await res.text();
  } else {
    const abs = resolve(source);
    if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
    text = readFileSync(abs, "utf-8");
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    try {
      doc = YAML.parse(text);
    } catch (e) {
      out({
        valid: false,
        errors: [{ path: "", message: `Parse error: ${(e as Error).message}` }],
      });
      return;
    }
  }

  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const version = doc.openapi || doc.swagger;
  if (!version) {
    errors.push({ path: "", message: "Missing 'openapi' or 'swagger' version field" });
    out({ valid: false, errors, warnings });
    return;
  }

  const isV3 = version.startsWith("3");

  validateInfo(doc, errors, warnings);

  validatePaths(doc, errors, warnings, isV3);

  if (isV3) {
    validateComponentsV3(doc, errors, warnings);
  } else {
    validateDefinitionsV2(doc, errors, warnings);
  }

  validateServers(doc, errors, warnings, isV3);

  validateRefs(doc, doc, "", errors);

  out({
    valid: errors.length === 0,
    version,
    title: doc.info?.title || null,
    operationCount: countOperations(doc),
    errors,
    warnings,
  });
}

function validateInfo(doc: Raw, errors: Issue[], warnings: Issue[]): void {
  if (!doc.info) {
    errors.push({ path: "info", message: "Missing required 'info' object" });
    return;
  }
  if (!doc.info.title) {
    errors.push({ path: "info.title", message: "Missing required 'info.title'" });
  }
  if (!doc.info.version) {
    errors.push({ path: "info.version", message: "Missing required 'info.version'" });
  }
  if (!doc.info.description) {
    warnings.push({
      path: "info.description",
      message: "Missing 'info.description' (recommended)",
    });
  }
}

function validatePaths(doc: Raw, errors: Issue[], warnings: Issue[], isV3: boolean): void {
  if (!doc.paths) {
    errors.push({ path: "paths", message: "Missing required 'paths' object" });
    return;
  }

  if (Object.keys(doc.paths).length === 0) {
    warnings.push({ path: "paths", message: "No paths defined" });
    return;
  }

  const METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
  const operationIds = new Set();

  for (const [path, methods] of Object.entries<Raw>(doc.paths)) {
    if (!path.startsWith("/")) {
      errors.push({ path: `paths.${path}`, message: `Path must start with '/'` });
    }

    const pathParams = (path.match(/\{([^}]+)\}/g) || []).map((p: Raw) => p.slice(1, -1));

    if (typeof methods !== "object" || methods === null) continue;

    for (const [method, op] of Object.entries<Raw>(methods)) {
      if (method.startsWith("x-") || method === "parameters" || method === "$ref") continue;

      if (!METHODS.has(method)) {
        warnings.push({
          path: `paths.${path}.${method}`,
          message: `Unknown HTTP method '${method}'`,
        });
        continue;
      }

      if (typeof op !== "object" || op === null) continue;

      const opPath = `paths.${path}.${method.toUpperCase()}`;

      if (op.operationId) {
        if (operationIds.has(op.operationId)) {
          errors.push({ path: opPath, message: `Duplicate operationId '${op.operationId}'` });
        }
        operationIds.add(op.operationId);
      } else {
        warnings.push({ path: opPath, message: "Missing operationId (recommended for agent use)" });
      }

      if (!op.responses || Object.keys(op.responses).length === 0) {
        errors.push({ path: opPath, message: "Missing or empty 'responses'" });
      }

      const declaredParams = new Set(
        (op.parameters || [])
          .filter((p: Raw) => (p.in || p.$ref) && (p.in === "path" || !p.in))
          .map((p: Raw) => p.name)
      );

      const pathLevelParams = (methods.parameters || [])
        .filter((p: Raw) => p.in === "path")
        .map((p: Raw) => p.name);

      for (const n of pathLevelParams) declaredParams.add(n);

      for (const param of pathParams) {
        if (!declaredParams.has(param)) {
          warnings.push({
            path: opPath,
            message: `Path parameter '{${param}}' may not be declared in parameters`,
          });
        }
      }

      if (isV3 && op.requestBody && ["get", "delete", "head"].includes(method)) {
        warnings.push({
          path: opPath,
          message: `requestBody on ${method.toUpperCase()} is unusual`,
        });
      }
    }
  }
}

function validateComponentsV3(doc: Raw, errors: Issue[], warnings: Issue[]): void {
  if (!doc.components) return;

  if (doc.components.schemas) {
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      validateSchema(schema, `components.schemas.${name}`, errors, warnings);
    }
  }
}

function validateDefinitionsV2(doc: Raw, errors: Issue[], warnings: Issue[]): void {
  if (!doc.definitions) return;

  for (const [name, schema] of Object.entries(doc.definitions)) {
    validateSchema(schema, `definitions.${name}`, errors, warnings);
  }
}

function validateSchema(schema: Raw, path: string, errors: Issue[], warnings: Issue[]): void {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) return;

  const VALID_TYPES = new Set([
    "string",
    "number",
    "integer",
    "boolean",
    "array",
    "object",
    "null",
  ]);

  if (schema.type && !VALID_TYPES.has(schema.type)) {
    errors.push({ path, message: `Invalid type '${schema.type}'` });
  }

  if (schema.type === "array" && !schema.items) {
    errors.push({ path, message: "Array type must have 'items'" });
  }

  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      validateSchema(val, `${path}.properties.${key}`, errors, warnings);
    }
  }
  if (schema.items) {
    validateSchema(schema.items, `${path}.items`, errors, warnings);
  }
}

function validateServers(doc: Raw, errors: Issue[], warnings: Issue[], isV3: boolean): void {
  if (isV3) {
    if (!doc.servers || doc.servers.length === 0) {
      warnings.push({
        path: "servers",
        message: "No servers defined — agent will need baseUrl configured",
      });
    }
  } else {
    if (!doc.host) {
      warnings.push({
        path: "host",
        message: "No host defined — agent will need baseUrl configured",
      });
    }
  }
}

function validateRefs(doc: Raw, root: Raw, path: string, errors: Issue[]): void {
  if (!doc || typeof doc !== "object") return;

  if (doc.$ref && typeof doc.$ref === "string") {
    if (doc.$ref.startsWith("#/")) {
      const parts = doc.$ref.slice(2).split("/");
      let target = root;
      for (const p of parts) {
        target = target?.[p];
      }
      if (target === undefined) {
        errors.push({ path: path || doc.$ref, message: `Broken $ref: '${doc.$ref}'` });
      }
    }
    return;
  }

  if (Array.isArray(doc)) {
    for (let i = 0; i < doc.length; i++) {
      validateRefs(doc[i], root, `${path}[${i}]`, errors);
    }
  } else {
    for (const [key, val] of Object.entries(doc)) {
      if (key === "raw") continue;
      validateRefs(val, root, path ? `${path}.${key}` : key, errors);
    }
  }
}

function countOperations(doc: Raw): number {
  let count = 0;
  for (const methods of Object.values<Raw>(doc.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (!method.startsWith("x-") && method !== "parameters" && method !== "$ref") count++;
    }
  }
  return count;
}

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import YAML from "yaml";
import { out } from "../output.js";
import { parseArgs } from "../args.js";

export async function validateSpec(args) {
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
      out({ valid: false, errors: [{ path: "", message: `Parse error: ${e.message}` }] });
      return;
    }
  }

  const errors = [];
  const warnings = [];

  // Detect spec version
  const version = doc.openapi || doc.swagger;
  if (!version) {
    errors.push({ path: "", message: "Missing 'openapi' or 'swagger' version field" });
    out({ valid: false, errors, warnings });
    return;
  }

  const isV3 = version.startsWith("3");

  // info object
  validateInfo(doc, errors, warnings);

  // paths
  validatePaths(doc, errors, warnings, isV3);

  // components / definitions
  if (isV3) {
    validateComponentsV3(doc, errors, warnings);
  } else {
    validateDefinitionsV2(doc, errors, warnings);
  }

  // servers (v3) or host (v2)
  validateServers(doc, errors, warnings, isV3);

  // Check for broken $ref
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

function validateInfo(doc, errors, warnings) {
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
    warnings.push({ path: "info.description", message: "Missing 'info.description' (recommended)" });
  }
}

function validatePaths(doc, errors, warnings, isV3) {
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

  for (const [path, methods] of Object.entries(doc.paths)) {
    // Path must start with /
    if (!path.startsWith("/")) {
      errors.push({ path: `paths.${path}`, message: `Path must start with '/'` });
    }

    // Check for unbalanced path params
    const pathParams = (path.match(/\{([^}]+)\}/g) || []).map((p) => p.slice(1, -1));

    if (typeof methods !== "object" || methods === null) continue;

    for (const [method, op] of Object.entries(methods)) {
      if (method.startsWith("x-") || method === "parameters" || method === "$ref") continue;

      if (!METHODS.has(method)) {
        warnings.push({ path: `paths.${path}.${method}`, message: `Unknown HTTP method '${method}'` });
        continue;
      }

      if (typeof op !== "object" || op === null) continue;

      const opPath = `paths.${path}.${method.toUpperCase()}`;

      // operationId uniqueness
      if (op.operationId) {
        if (operationIds.has(op.operationId)) {
          errors.push({ path: opPath, message: `Duplicate operationId '${op.operationId}'` });
        }
        operationIds.add(op.operationId);
      } else {
        warnings.push({ path: opPath, message: "Missing operationId (recommended for agent use)" });
      }

      // Responses required
      if (!op.responses || Object.keys(op.responses).length === 0) {
        errors.push({ path: opPath, message: "Missing or empty 'responses'" });
      }

      // Check path params are declared
      const declaredParams = new Set(
        (op.parameters || [])
          .filter((p) => (p.in || p.$ref) && (p.in === "path" || !p.in))
          .map((p) => p.name)
      );

      // Also include path-level parameters
      const pathLevelParams = (methods.parameters || [])
        .filter((p) => p.in === "path")
        .map((p) => p.name);

      for (const n of pathLevelParams) declaredParams.add(n);

      for (const param of pathParams) {
        if (!declaredParams.has(param)) {
          // Only warn — the param might be declared via $ref
          warnings.push({ path: opPath, message: `Path parameter '{${param}}' may not be declared in parameters` });
        }
      }

      // Request body on GET/DELETE/HEAD
      if (isV3 && op.requestBody && ["get", "delete", "head"].includes(method)) {
        warnings.push({ path: opPath, message: `requestBody on ${method.toUpperCase()} is unusual` });
      }
    }
  }
}

function validateComponentsV3(doc, errors, warnings) {
  if (!doc.components) return;

  // Check schemas have valid types
  if (doc.components.schemas) {
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      validateSchema(schema, `components.schemas.${name}`, errors, warnings);
    }
  }
}

function validateDefinitionsV2(doc, errors, warnings) {
  if (!doc.definitions) return;

  for (const [name, schema] of Object.entries(doc.definitions)) {
    validateSchema(schema, `definitions.${name}`, errors, warnings);
  }
}

function validateSchema(schema, path, errors, warnings) {
  if (!schema || typeof schema !== "object") return;
  if (schema.$ref) return; // reference, skip

  const VALID_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object", "null"]);

  if (schema.type && !VALID_TYPES.has(schema.type)) {
    errors.push({ path, message: `Invalid type '${schema.type}'` });
  }

  if (schema.type === "array" && !schema.items) {
    errors.push({ path, message: "Array type must have 'items'" });
  }

  // Recurse into properties
  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      validateSchema(val, `${path}.properties.${key}`, errors, warnings);
    }
  }
  if (schema.items) {
    validateSchema(schema.items, `${path}.items`, errors, warnings);
  }
}

function validateServers(doc, errors, warnings, isV3) {
  if (isV3) {
    if (!doc.servers || doc.servers.length === 0) {
      warnings.push({ path: "servers", message: "No servers defined — agent will need baseUrl configured" });
    }
  } else {
    if (!doc.host) {
      warnings.push({ path: "host", message: "No host defined — agent will need baseUrl configured" });
    }
  }
}

function validateRefs(doc, root, path, errors) {
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
    return; // Don't recurse into $ref
  }

  if (Array.isArray(doc)) {
    for (let i = 0; i < doc.length; i++) {
      validateRefs(doc[i], root, `${path}[${i}]`, errors);
    }
  } else {
    for (const [key, val] of Object.entries(doc)) {
      if (key === "raw") continue; // skip stored raw data
      validateRefs(val, root, path ? `${path}.${key}` : key, errors);
    }
  }
}

function countOperations(doc) {
  let count = 0;
  for (const methods of Object.values(doc.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (!method.startsWith("x-") && method !== "parameters" && method !== "$ref") count++;
    }
  }
  return count;
}

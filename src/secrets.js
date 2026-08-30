import { existsSync, readFileSync } from "fs";

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

export function expandSecrets(str) {
  if (typeof str !== "string") return str;
  if (str.startsWith("file:")) {
    const filePath = str.slice(5);
    if (!existsSync(filePath)) throw new Error(`Secret file not found: ${filePath}`);
    str = readFileSync(filePath, "utf-8").replace(/\r?\n$/, "");
  } else if (str.startsWith("env:")) {
    const name = str.slice(4);
    if (!(name in process.env)) throw new Error(`Environment variable not set: ${name}`);
    str = process.env[name];
  }
  if (typeof str !== "string" || !str.includes("${")) return str;
  return str.replace(ENV_VAR_RE, (_, name) => {
    if (!(name in process.env)) throw new Error(`Environment variable not set: ${name}`);
    return process.env[name];
  });
}

export function specRequestHeaders(config = {}) {
  const headers = expandSecretsMap({ ...(config.headers || {}) }) || {};
  const rawAuth = config.auth ? expandSecrets(config.auth) : config.auth;
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (rawAuth && !hasAuthHeader) {
    headers.Authorization =
      rawAuth.startsWith("Bearer ") || rawAuth.startsWith("Basic ") ? rawAuth : `Bearer ${rawAuth}`;
  }
  return headers;
}

export function expandSecretsMap(obj) {
  if (!obj || typeof obj !== "object") return obj;
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, expandSecrets(v)]));
}

export function envHeaderOverrides() {
  const headers = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SPEC_HEADER_")) continue;
    const headerName = key.slice("SPEC_HEADER_".length).replace(/_/g, "-").toLowerCase();
    headers[headerName] = value;
  }
  return headers;
}

export function mergeHeaders(...maps) {
  const canonical = {};
  const result = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, value] of Object.entries(map)) {
      const lower = key.toLowerCase();
      if (lower in canonical) {
        delete result[canonical[lower]];
      }
      canonical[lower] = key;
      result[key] = value;
    }
  }
  return result;
}

export function envUrlOverride() {
  return process.env.SPEC_URL;
}

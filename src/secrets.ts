import { existsSync, readFileSync } from "node:fs";
import type { HttpSpecConfig, StringMap } from "./types.ts";

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

function envValue(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Environment variable not set: ${name}`);
  return value;
}

export function expandSecrets<T>(value: T): T {
  if (typeof value !== "string") return value;
  let str: string = value;
  if (str.startsWith("file:")) {
    const filePath = str.slice(5);
    if (!existsSync(filePath)) throw new Error(`Secret file not found: ${filePath}`);
    str = readFileSync(filePath, "utf-8").replace(/\r?\n$/, "");
  } else if (str.startsWith("env:")) {
    str = envValue(str.slice(4));
  }
  if (!str.includes("${")) return str as T;
  return str.replace(ENV_VAR_RE, (_, name: string) => envValue(name)) as T;
}

export function expandSecretsMap<T extends StringMap | null | undefined>(map: T): T {
  if (!map || typeof map !== "object") return map;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expandSecrets(v)])) as T;
}

export function hasHeader(headers: StringMap, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

export function authorizationValue(auth: string): string {
  return auth.startsWith("Bearer ") || auth.startsWith("Basic ") ? auth : `Bearer ${auth}`;
}

export function specRequestHeaders(config: HttpSpecConfig = {}): StringMap {
  const headers = expandSecretsMap({ ...config.headers });
  const auth = config.auth ? expandSecrets(config.auth) : config.auth;
  if (auth && !hasHeader(headers, "authorization"))
    headers.Authorization = authorizationValue(auth);
  return headers;
}

export function envHeaderOverrides(): StringMap {
  const headers: StringMap = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("SPEC_HEADER_") || value === undefined) continue;
    headers[key.slice("SPEC_HEADER_".length).replace(/_/g, "-").toLowerCase()] = value;
  }
  return headers;
}

export function mergeHeaders(...maps: Array<StringMap | undefined>): StringMap {
  const canonical: StringMap = {};
  const result: StringMap = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [key, value] of Object.entries(map)) {
      const lower = key.toLowerCase();
      if (lower in canonical) delete result[canonical[lower]!];
      canonical[lower] = key;
      result[key] = value;
    }
  }
  return result;
}

export function envUrlOverride(): string | undefined {
  return process.env.SPEC_URL;
}

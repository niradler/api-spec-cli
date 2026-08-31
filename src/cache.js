import { homedir } from "os";
import { join } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  chmodSync,
} from "fs";
import { createHash } from "crypto";

const META_TTL_MS = 30 * 60 * 1000;
const CALL_TTL_MS = 60 * 1000;

let CACHE_DIR = join(homedir(), "spec-cli-config", "cache");

export function setCacheDir(dir) {
  CACHE_DIR = dir;
}

export function getCacheDir() {
  return CACHE_DIR;
}

function enabled() {
  return !process.env.SPEC_NO_CACHE;
}

function parseTtl(envName, fallback) {
  const n = parseInt(process.env[envName] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function metaTtl() {
  return parseTtl("SPEC_META_CACHE_MS", META_TTL_MS);
}

function callTtl() {
  return parseTtl("SPEC_CALL_CACHE_MS", CALL_TTL_MS);
}

function ensureDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

function writeCacheFile(file, rec) {
  writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function safeKey(key) {
  return String(key)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function metaFile(key) {
  return join(CACHE_DIR, `meta-${safeKey(key)}.json`);
}

function callFile(key) {
  return join(CACHE_DIR, `call-${safeKey(key)}.json`);
}

function legacyMetaFile(key) {
  return join(CACHE_DIR, `${safeKey(key)}.json`);
}

function readRecord(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function isExpired(rec, fallbackTtl) {
  if (!rec || typeof rec !== "object") return true;
  const at = rec.cachedAt;
  if (!at) return true;
  const ttl = typeof rec.ttl === "number" ? rec.ttl : fallbackTtl;
  return Date.now() - at > ttl;
}

function unwrap(rec) {
  if (rec && Object.prototype.hasOwnProperty.call(rec, "data") && rec.cachedAt) return rec.data;
  if (rec && rec.spec && rec.cachedAt) return rec.spec;
  return rec;
}

export function sweepCache() {
  if (!existsSync(CACHE_DIR)) return;
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.endsWith(".json")) continue;
    const file = join(CACHE_DIR, name);
    const rec = readRecord(file);
    if (
      !rec ||
      rec.cachedAt == null ||
      isExpired(rec, name.startsWith("call-") ? callTtl() : metaTtl())
    ) {
      try {
        rmSync(file);
      } catch {}
    }
  }
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sorted(value[key]);
    return out;
  }
  return value;
}

export function callCacheKey(parts) {
  const json = JSON.stringify(sorted(parts ?? {}));
  return createHash("sha256").update(json).digest("hex").slice(0, 32);
}

export function metaCacheKey(entry) {
  if (entry?.name && !String(entry.name).startsWith("inline-")) return entry.name;
  const json = JSON.stringify(
    sorted({
      type: entry?.type,
      url: entry?.url,
      source: entry?.source,
      command: entry?.command,
      args: entry?.args,
      cwd: entry?.cwd,
      env: entry?.env,
      headers: entry?.headers,
      allowedTools: entry?.allowedTools,
      disabledTools: entry?.disabledTools,
      config: {
        allowedTools: entry?.config?.allowedTools,
        disabledTools: entry?.config?.disabledTools,
        headers: entry?.config?.headers,
        auth: entry?.config?.auth,
        baseUrl: entry?.config?.baseUrl,
      },
    })
  );
  return "inline-" + createHash("sha256").update(json).digest("hex").slice(0, 16);
}

export function getMetaCache(key) {
  if (!enabled()) return null;
  const primary = metaFile(key);
  const legacy = legacyMetaFile(key);
  for (const file of [primary, legacy]) {
    const rec = readRecord(file);
    if (!rec) continue;
    const wrapped = rec.cachedAt != null && rec.data !== undefined;
    if (!wrapped || isExpired(rec, metaTtl())) {
      try {
        rmSync(file);
      } catch {}
      continue;
    }
    return unwrap(rec);
  }
  return null;
}

export function setMetaCache(key, spec) {
  if (!enabled()) return;
  ensureDir();
  const file = metaFile(key);
  writeCacheFile(file, { kind: "meta", cachedAt: Date.now(), ttl: metaTtl(), data: spec });
  const legacy = legacyMetaFile(key);
  if (legacy !== file && existsSync(legacy)) {
    try {
      rmSync(legacy);
    } catch {}
  }
}

export function removeMetaCache(key) {
  for (const file of [metaFile(key), legacyMetaFile(key)]) {
    if (existsSync(file)) {
      try {
        rmSync(file);
      } catch {}
    }
  }
}

export function getCallCache(key) {
  if (!enabled()) return null;
  const rec = readRecord(callFile(key));
  if (!rec) return null;
  if (isExpired(rec, callTtl())) {
    try {
      rmSync(callFile(key));
    } catch {}
    return null;
  }
  return unwrap(rec);
}

export function setCallCache(key, payload, extra = {}) {
  if (!enabled()) return;
  ensureDir();
  writeCacheFile(callFile(key), {
    kind: "call",
    cachedAt: Date.now(),
    ttl: callTtl(),
    spec: extra.spec || null,
    data: payload,
  });
}

export function removeCallCachesForSpec(specName) {
  if (!specName || !existsSync(CACHE_DIR)) return;
  for (const name of readdirSync(CACHE_DIR)) {
    if (!name.startsWith("call-") || !name.endsWith(".json")) continue;
    const file = join(CACHE_DIR, name);
    const rec = readRecord(file);
    if (rec?.spec === specName) {
      try {
        rmSync(file);
      } catch {}
    }
  }
}

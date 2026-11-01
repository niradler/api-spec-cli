import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { specHome } from "./paths.ts";
import type { ResolvedEntry, SpecDocument } from "./types.ts";

const META_TTL_MS = 30 * 60 * 1000;
const CALL_TTL_MS = 60 * 1000;

interface CacheRecord {
  kind?: "meta" | "call";
  cachedAt?: number;
  ttl?: number;
  spec?: unknown;
  data?: unknown;
}

let cacheDirOverride: string | undefined;

export function setCacheDir(dir: string | undefined): void {
  cacheDirOverride = dir;
}

export function getCacheDir(): string {
  return cacheDirOverride ?? join(specHome(), "cache");
}

function enabled(): boolean {
  return !process.env.SPEC_NO_CACHE;
}

function parseTtl(envName: string, fallback: number): number {
  const n = parseInt(process.env[envName] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function metaTtl(): number {
  return parseTtl("SPEC_META_CACHE_MS", META_TTL_MS);
}

function callTtl(): number {
  return parseTtl("SPEC_CALL_CACHE_MS", CALL_TTL_MS);
}

function remove(file: string): void {
  try {
    rmSync(file);
  } catch {}
}

function writeCacheFile(file: string, rec: CacheRecord): void {
  mkdirSync(getCacheDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function safeKey(key: string): string {
  return String(key)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function metaFile(key: string): string {
  return join(getCacheDir(), `meta-${safeKey(key)}.json`);
}

function callFile(key: string): string {
  return join(getCacheDir(), `call-${safeKey(key)}.json`);
}

function legacyMetaFile(key: string): string {
  return join(getCacheDir(), `${safeKey(key)}.json`);
}

function readRecord(file: string): CacheRecord | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as CacheRecord;
  } catch {
    return null;
  }
}

function isExpired(rec: CacheRecord | null, fallbackTtl: number): boolean {
  if (!rec || typeof rec !== "object" || !rec.cachedAt) return true;
  const ttl = typeof rec.ttl === "number" ? rec.ttl : fallbackTtl;
  return Date.now() - rec.cachedAt > ttl;
}

export function sweepCache(): void {
  const dir = getCacheDir();
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    const rec = readRecord(file);
    if (
      !rec ||
      rec.cachedAt == null ||
      isExpired(rec, name.startsWith("call-") ? callTtl() : metaTtl())
    )
      remove(file);
  }
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])])
    );
  }
  return value;
}

function hash(value: unknown, length: number): string {
  return createHash("sha256")
    .update(JSON.stringify(sorted(value ?? {})))
    .digest("hex")
    .slice(0, length);
}

export function callCacheKey(parts: unknown): string {
  return hash(parts, 32);
}

export function metaCacheSpec(resolved: ResolvedEntry): string | null {
  return resolved.name && !resolved.name.startsWith("inline-") ? resolved.name : null;
}

export function metaCacheKey(resolved: ResolvedEntry): string {
  const entry = resolved as unknown as Record<string, unknown>;
  const config = (entry.config ?? {}) as Record<string, unknown>;
  const fingerprint = hash(
    {
      format: 2,
      type: entry.type,
      url: entry.url,
      source: entry.source,
      command: entry.command,
      args: entry.args,
      cwd: entry.cwd,
      env: entry.env,
      headers: entry.headers,
      allowedTools: entry.allowedTools,
      disabledTools: entry.disabledTools,
      config: {
        allowedTools: config.allowedTools,
        disabledTools: config.disabledTools,
        headers: config.headers,
        auth: config.auth,
        baseUrl: config.baseUrl,
      },
    },
    16
  );
  return `${metaCacheSpec(resolved) ?? "inline"}-${fingerprint}`;
}

export function getMetaCache(key: string): SpecDocument | null {
  if (!enabled()) return null;
  for (const file of [metaFile(key), legacyMetaFile(key)]) {
    const rec = readRecord(file);
    if (!rec) continue;
    if (rec.cachedAt == null || rec.data === undefined || isExpired(rec, metaTtl())) {
      remove(file);
      continue;
    }
    return rec.data as SpecDocument;
  }
  return null;
}

export function setMetaCache(
  key: string,
  spec: SpecDocument,
  extra: { spec?: string | null } = {}
): void {
  if (!enabled()) return;
  const file = metaFile(key);
  writeCacheFile(file, {
    kind: "meta",
    cachedAt: Date.now(),
    ttl: metaTtl(),
    spec: extra.spec || null,
    data: spec,
  });
  const legacy = legacyMetaFile(key);
  if (legacy !== file && existsSync(legacy)) remove(legacy);
}

export function removeMetaCache(key: string): void {
  for (const file of [metaFile(key), legacyMetaFile(key)]) if (existsSync(file)) remove(file);
}

export function getCallCache<T>(key: string): T | null {
  if (!enabled()) return null;
  const file = callFile(key);
  const rec = readRecord(file);
  if (!rec) return null;
  if (isExpired(rec, callTtl())) {
    remove(file);
    return null;
  }
  return (rec.data !== undefined ? rec.data : rec) as T;
}

export function setCallCache(
  key: string,
  payload: unknown,
  extra: { spec?: string | null } = {}
): void {
  if (!enabled()) return;
  writeCacheFile(callFile(key), {
    kind: "call",
    cachedAt: Date.now(),
    ttl: callTtl(),
    spec: extra.spec || null,
    data: payload,
  });
}

export function removeCallCachesForSpec(specName: string): void {
  const dir = getCacheDir();
  if (!specName || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("call-") || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    if (readRecord(file)?.spec === specName) remove(file);
  }
}

export function removeMetaCachesForSpec(specName: string): void {
  removeMetaCache(specName);
  const dir = getCacheDir();
  if (!specName || !existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("meta-") || !name.endsWith(".json")) continue;
    const file = join(dir, name);
    if (readRecord(file)?.spec === specName) remove(file);
  }
}

export function removeCachedSpec(name: string): void {
  removeMetaCachesForSpec(name);
  removeCallCachesForSpec(name);
}

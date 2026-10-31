import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specHome } from "./paths.ts";

export interface UsageRecord {
  count: number;
  lastUsed: string | null;
}

export type UsageStore = Record<string, Record<string, UsageRecord>>;

export interface TopOperation extends UsageRecord {
  id: string;
}

let usageDirOverride: string | undefined;

export function setUsageDir(dir: string | undefined): void {
  usageDirOverride = dir;
}

function usageDir(): string {
  return usageDirOverride ?? specHome();
}

function usagePath(): string {
  return join(usageDir(), "usage.json");
}

function loadStore(): UsageStore {
  const file = usagePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as UsageStore;
  } catch {
    return {};
  }
}

function saveStore(store: UsageStore): void {
  mkdirSync(usageDir(), { recursive: true });
  writeFileSync(usagePath(), JSON.stringify(store, null, 2));
}

export function recordUsage(specName: string | undefined, operationId: string | undefined): void {
  if (process.env.SPEC_NO_USAGE) return;
  if (!specName || !operationId) return;
  try {
    const store = loadStore();
    const perSpec = (store[specName] ??= {});
    const entry = perSpec[operationId] ?? { count: 0, lastUsed: null };
    entry.count += 1;
    entry.lastUsed = new Date().toISOString();
    perSpec[operationId] = entry;
    saveStore(store);
  } catch {}
}

export function getUsage(specName: string): Record<string, UsageRecord> {
  return loadStore()[specName] ?? {};
}

export function topOperations(specName: string, n: number): TopOperation[] {
  return Object.entries(getUsage(specName))
    .map(([id, { count, lastUsed }]) => ({ id, count, lastUsed }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (b.lastUsed || "") < (a.lastUsed || "") ? -1 : 1;
    })
    .slice(0, n);
}

export function allUsage(): UsageStore {
  return loadStore();
}

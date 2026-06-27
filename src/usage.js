import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

let USAGE_DIR = join(homedir(), "spec-cli-config");

export function setUsageDir(dir) {
  USAGE_DIR = dir;
}

function usagePath() {
  return join(USAGE_DIR, "usage.json");
}

function loadStore() {
  const file = usagePath();
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function saveStore(store) {
  mkdirSync(USAGE_DIR, { recursive: true });
  writeFileSync(usagePath(), JSON.stringify(store, null, 2));
}

export function recordUsage(specName, operationId) {
  if (process.env.SPEC_NO_USAGE) return;
  if (!specName || !operationId) return;
  try {
    const store = loadStore();
    if (!store[specName]) store[specName] = {};
    const entry = store[specName][operationId] || { count: 0, lastUsed: null };
    entry.count += 1;
    entry.lastUsed = new Date().toISOString();
    store[specName][operationId] = entry;
    saveStore(store);
  } catch {}
}

export function getUsage(specName) {
  const store = loadStore();
  return store[specName] || {};
}

export function topOperations(specName, n) {
  const perSpec = getUsage(specName);
  return Object.entries(perSpec)
    .map(([id, { count, lastUsed }]) => ({ id, count, lastUsed }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return (b.lastUsed || "") < (a.lastUsed || "") ? -1 : 1;
    })
    .slice(0, n);
}

export function allUsage() {
  return loadStore();
}

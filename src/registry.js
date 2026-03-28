import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

const REGISTRY_DIR = join(homedir(), "spec-cli-config");
const REGISTRY_FILE = join(REGISTRY_DIR, "registry.json");
const CACHE_DIR = join(REGISTRY_DIR, "cache");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getRegistry() {
  if (!existsSync(REGISTRY_FILE)) return [];
  try {
    return JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
  } catch {
    throw new Error(`Registry file is corrupt: ${REGISTRY_FILE}. Delete it to reset.`);
  }
}

export function saveRegistry(entries) {
  ensureDir(REGISTRY_DIR);
  writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
}

export function getEntry(name) {
  const registry = getRegistry();
  const entry = registry.find((e) => e.name === name);
  if (!entry) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
  if (!entry.enabled) throw new Error(`Spec '${name}' is disabled. Run 'spec enable ${name}' first.`);
  return entry;
}

export function getCachedSpec(name) {
  const file = join(CACHE_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null; // Corrupt cache is treated as a miss — will re-fetch
  }
}

export function saveCachedSpec(name, spec) {
  ensureDir(CACHE_DIR);
  writeFileSync(join(CACHE_DIR, `${name}.json`), JSON.stringify(spec, null, 2));
}

export function removeCachedSpec(name) {
  const file = join(CACHE_DIR, `${name}.json`);
  if (existsSync(file)) rmSync(file);
}

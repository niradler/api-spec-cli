import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

const REGISTRY_DIR = join(homedir(), "spec-cli-config");
const REGISTRY_FILE = join(REGISTRY_DIR, "registry.json");
const CACHE_DIR = join(REGISTRY_DIR, "cache");

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const EMPTY = { mcp: {}, openapi: {}, graphql: {} };

export function getRegistry() {
  if (!existsSync(REGISTRY_FILE)) return { ...EMPTY };
  try {
    const data = JSON.parse(readFileSync(REGISTRY_FILE, "utf-8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`Registry file has old format: ${REGISTRY_FILE}. Delete it to reset.`);
    }
    return data;
  } catch (e) {
    if (e.message.includes("old format")) throw e;
    throw new Error(`Registry file is corrupt: ${REGISTRY_FILE}. Delete it to reset.`);
  }
}

export function saveRegistry(registry) {
  ensureDir(REGISTRY_DIR);
  writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2));
}

/**
 * Find an entry by name across all sections.
 * Returns the entry with `name` and `_section` injected.
 */
export function allEntries(registry) {
  const entries = [];
  for (const section of ["mcp", "openapi", "graphql"]) {
    for (const [name, entry] of Object.entries(registry[section] || {})) {
      entries.push({ ...entry, name, _section: section });
    }
  }
  return entries;
}

export function getEntry(name) {
  const registry = getRegistry();
  for (const section of ["mcp", "openapi", "graphql"]) {
    const entry = registry[section]?.[name];
    if (entry) {
      if (!entry.enabled)
        throw new Error(`Spec '${name}' is disabled. Run 'spec enable ${name}' first.`);
      return { ...entry, name, _section: section };
    }
  }
  throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
}

export function getCachedSpec(name) {
  const file = join(CACHE_DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
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

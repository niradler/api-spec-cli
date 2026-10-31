import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeCachedSpec } from "./cache.ts";
import { specHome } from "./paths.ts";
import { resolvedEntry } from "./sources.ts";
import type {
  NamedEntry,
  Registry,
  RegistryEntry,
  RegistrySection,
  RegistryStore,
} from "./types.ts";

export { removeCachedSpec };

export const SECTIONS: RegistrySection[] = ["mcp", "openapi", "graphql"];

export function emptyRegistry(): Registry {
  return { mcp: {}, openapi: {}, graphql: {} };
}

export function registryPath(): string {
  return join(specHome(), "registry.json");
}

export function getRegistry(): Registry {
  const file = registryPath();
  if (!existsSync(file)) return emptyRegistry();
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    throw new Error(`Registry file is corrupt: ${file}. Delete it to reset.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`Registry file has old format: ${file}. Delete it to reset.`);
  }
  return data as Registry;
}

export function saveRegistry(registry: Registry): void {
  mkdirSync(specHome(), { recursive: true });
  writeFileSync(registryPath(), JSON.stringify(registry, null, 2), { mode: 0o600 });
}

export function fileRegistryStore(): RegistryStore {
  return { read: getRegistry, write: saveRegistry };
}

export function memoryRegistryStore(initial: Partial<Registry> = {}): RegistryStore {
  let registry: Registry = structuredClone({ ...emptyRegistry(), ...initial });
  return {
    read: () => structuredClone(registry),
    write: (next) => {
      registry = structuredClone(next);
    },
  };
}

export function allEntries(registry: Partial<Registry>): NamedEntry[] {
  return SECTIONS.flatMap((section) =>
    Object.entries((registry[section] ?? {}) as Record<string, RegistryEntry>).map(
      ([name, entry]) => ({ ...entry, name, _section: section }) as NamedEntry
    )
  );
}

export function findEntry(registry: Partial<Registry>, name: string): NamedEntry | undefined {
  for (const section of SECTIONS) {
    const entry = (registry[section] as Record<string, RegistryEntry> | undefined)?.[name];
    if (entry) return { ...entry, name, _section: section } as NamedEntry;
  }
  return undefined;
}

export function getEntry(name: string, registry: Partial<Registry> = getRegistry()): NamedEntry {
  const entry = findEntry(registry, name);
  if (!entry) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
  if (!entry.enabled)
    throw new Error(`Spec '${name}' is disabled. Run 'spec enable ${name}' first.`);
  return entry;
}

export function putEntry(
  registry: Registry,
  name: string,
  entry: RegistryEntry
): { registry: Registry; overwritten: boolean } {
  let overwritten = false;
  for (const section of SECTIONS) {
    const bucket = registry[section] as Record<string, RegistryEntry>;
    if (bucket?.[name]) {
      delete bucket[name];
      overwritten = true;
    }
  }
  const section = resolvedEntry(entry)._section;
  ((registry[section] ??= {}) as Record<string, RegistryEntry>)[name] = entry;
  return { registry, overwritten };
}

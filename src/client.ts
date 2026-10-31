import { createToolCatalog, type ToolCatalog, type ToolScope } from "./catalog.ts";
import { removeCachedSpec } from "./cache.ts";
import { executeOperation, type CallRequest, type CallResult } from "./execute.ts";
import { closeMcpClients } from "./mcp-client.ts";
import { runOAuthFlow, type OAuthFlowResult } from "./oauth/auth-flow.ts";
import { clearTokenFile, saveTokenFile } from "./oauth/tokens.ts";
import {
  describeOperation,
  describeType,
  grepOperations,
  listOperations,
  listTypes,
  operations as specOperations,
  type GrepMatch,
  type ListOptions,
  type OperationList,
  type SpecTypes,
} from "./operations.ts";
import { allEntries, fileRegistryStore, findEntry, getEntry, putEntry } from "./registry.ts";
import { loadSpec as loadSpecDocument, withAuthFrom } from "./resolve.ts";
import { assertSpecName, entryFromSource, resolvedEntry } from "./sources.ts";
import { getUsage } from "./usage.ts";
import type {
  LoadedSpec,
  NamedEntry,
  PageOptions,
  RegistryEntry,
  RegistrySection,
  RegistryStore,
  ResolvedEntry,
  SpecDocument,
  SpecRef,
  SpecSource,
  SpecType,
} from "./types.ts";

export type SpecLoader = (
  entry: ResolvedEntry,
  options?: { refresh?: boolean }
) => Promise<SpecDocument>;

export interface SpecClientOptions {
  registry?: RegistryStore;
  scopes?: ToolScope[];
  loadSpec?: SpecLoader;
  execute?: typeof executeOperation;
}

export interface SpecSummary {
  name: string;
  type: RegistryEntry["type"];
  description: string | null;
  enabled: boolean;
}

export interface SpecListOptions {
  filter?: string;
  compact?: boolean;
}

export interface AddResult {
  name: string;
  section: RegistrySection;
  type: RegistryEntry["type"];
  entry: NamedEntry;
  overwritten: boolean;
}

export interface RefreshResult {
  name: string;
  type: SpecType;
  count: number;
}

export interface GrepOptions extends PageOptions {
  spec?: string;
}

export interface GrepGroup {
  spec: string;
  type: SpecType;
  matches: GrepMatch[];
}

export interface GrepResult {
  pattern: string;
  total: number;
  showing: number;
  results: GrepGroup[];
  offset?: number;
  limit?: number;
}

export interface SpecClient {
  specs: {
    list(options?: SpecListOptions): (SpecSummary | NamedEntry)[];
    get(name: string): NamedEntry;
    add(name: string, source: SpecSource): AddResult;
    remove(name: string): void;
    enable(name: string): void;
    disable(name: string): void;
    refresh(name: string): Promise<RefreshResult>;
    authorize(name: string): Promise<OAuthFlowResult>;
    revoke(name: string): void;
  };
  operations: {
    load(ref: SpecRef, options?: { refresh?: boolean }): Promise<LoadedSpec>;
    list(ref: SpecRef, options?: ListOptions): Promise<OperationList>;
    show(ref: SpecRef, target: string): Promise<Record<string, unknown>>;
    types(ref: SpecRef): Promise<SpecTypes>;
    type(ref: SpecRef, target: string): Promise<Record<string, unknown>>;
    grep(pattern: string, options?: GrepOptions): Promise<GrepResult>;
    call(ref: SpecRef, target: string, request?: CallRequest): Promise<CallResult>;
  };
  tools: ToolCatalog;
  close(): Promise<void>;
}

function summary(entry: NamedEntry): SpecSummary {
  return {
    name: entry.name,
    type: entry.type,
    description: entry.description || null,
    enabled: entry.enabled,
  };
}

function requireRemoteMcp(entry: NamedEntry) {
  if (entry._section !== "mcp" || entry.type === "stdio")
    throw new Error(
      `'${entry.name}' is not an HTTP/SSE MCP spec — OAuth only applies to mcp http and sse entries`
    );
  return entry;
}

export function paginateGrep(
  pattern: string,
  groups: GrepGroup[],
  { offset = 0, limit = 0 }: PageOptions = {}
): GrepResult {
  const flat = groups.flatMap((group) =>
    group.matches.map((match) => ({ spec: group.spec, type: group.type, match }))
  );
  let page = flat;
  if (offset > 0) page = page.slice(offset);
  if (limit > 0) page = page.slice(0, limit);

  const results: GrepGroup[] = [];
  const index = new Map<string, GrepGroup>();
  for (const row of page) {
    let group = index.get(row.spec);
    if (!group) {
      group = { spec: row.spec, type: row.type, matches: [] };
      index.set(row.spec, group);
      results.push(group);
    }
    group.matches.push(row.match);
  }

  const result: GrepResult = { pattern, total: flat.length, showing: page.length, results };
  if (offset > 0) result.offset = offset;
  if (limit > 0 && page.length < flat.length) result.limit = limit;
  return result;
}

export function createSpecClient(options: SpecClientOptions = {}): SpecClient {
  const store = options.registry ?? fileRegistryStore();
  const load = options.loadSpec ?? loadSpecDocument;

  function lookup(name: string): NamedEntry {
    const entry = findEntry(store.read(), name);
    if (!entry) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
    return entry;
  }

  function setEnabled(name: string, enabled: boolean): void {
    const registry = store.read();
    const entry = findEntry(registry, name);
    if (!entry) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
    (registry[entry._section] as Record<string, RegistryEntry>)[name]!.enabled = enabled;
    store.write(registry);
  }

  function entryFor(ref: SpecRef): ResolvedEntry {
    return typeof ref === "string"
      ? getEntry(ref, store.read())
      : resolvedEntry(entryFromSource(ref));
  }

  async function loadRef(
    ref: SpecRef,
    loadOptions: { refresh?: boolean } = {}
  ): Promise<LoadedSpec> {
    const entry = entryFor(ref);
    return { spec: await load(entry, loadOptions), entry };
  }

  const specs: SpecClient["specs"] = {
    list({ filter, compact = true } = {}) {
      const needle = filter?.toLowerCase();
      return allEntries(store.read())
        .filter(
          (entry) =>
            !needle ||
            entry.name.toLowerCase().includes(needle) ||
            (entry.description && entry.description.toLowerCase().includes(needle))
        )
        .map((entry) => (compact ? summary(entry) : entry));
    },
    get: lookup,
    add(name, source) {
      assertSpecName(name);
      const entry = entryFromSource(source);
      const { registry, overwritten } = putEntry(store.read(), name, entry);
      store.write(registry);
      if (overwritten) removeCachedSpec(name);
      if ((source.type === "http" || source.type === "sse") && source.oauthClientSecret)
        saveTokenFile(name, { clientSecret: source.oauthClientSecret });
      const resolved = resolvedEntry(entry, name) as NamedEntry;
      return { name, section: resolved._section, type: entry.type, entry: resolved, overwritten };
    },
    remove(name) {
      const registry = store.read();
      const entry = findEntry(registry, name);
      if (!entry) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
      delete (registry[entry._section] as Record<string, RegistryEntry>)[name];
      store.write(registry);
      removeCachedSpec(name);
      clearTokenFile(name, { revokeAll: true });
    },
    enable: (name) => setEnabled(name, true),
    disable: (name) => setEnabled(name, false),
    async refresh(name) {
      const entry = lookup(name);
      if (!entry.enabled) throw new Error(`Spec '${name}' is disabled. Enable it first.`);
      removeCachedSpec(name);
      const spec = await load(entry, { refresh: true });
      return { name, type: spec.type, count: specOperations(spec).length };
    },
    async authorize(name) {
      const entry = requireRemoteMcp(getEntry(name, store.read()));
      clearTokenFile(name);
      return await runOAuthFlow(name, entry);
    },
    revoke(name) {
      requireRemoteMcp(getEntry(name, store.read()));
      clearTokenFile(name, { revokeAll: true });
    },
  };

  const operations: SpecClient["operations"] = {
    load: loadRef,
    async list(ref, listOptions = {}) {
      const { spec } = await loadRef(ref);
      const usage = listOptions.usage ?? (typeof ref === "string" ? getUsage(ref) : {});
      return listOperations(spec, { ...listOptions, usage });
    },
    async show(ref, target) {
      return describeOperation((await loadRef(ref)).spec, target);
    },
    async types(ref) {
      return listTypes((await loadRef(ref)).spec);
    },
    async type(ref, target) {
      return describeType((await loadRef(ref)).spec, target);
    },
    async grep(pattern, grepOptions = {}) {
      const entries = grepOptions.spec
        ? [getEntry(grepOptions.spec, store.read())]
        : allEntries(store.read()).filter((entry) => entry.enabled);
      if (entries.length === 0) throw new Error("No registered specs. Run 'spec add' first.");
      const groups: GrepGroup[] = [];
      for (const entry of entries) {
        const spec = await load(entry);
        const matches = grepOperations(spec, pattern);
        if (matches.length > 0) groups.push({ spec: entry.name, type: spec.type, matches });
      }
      return paginateGrep(pattern, groups, grepOptions);
    },
    async call(ref, target, request = {}) {
      const entry = withAuthFrom(entryFor(ref), request);
      const spec = await load(entry);
      return await (options.execute ?? executeOperation)(spec, entry, target, request);
    },
  };

  const tools = createToolCatalog({
    entries: () => allEntries(store.read()),
    load: (entry) => load(entry),
    execute: options.execute,
    scopes: options.scopes,
  });

  return { specs, operations, tools, close: closeMcpClients };
}

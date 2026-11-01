import {
  createToolCatalog,
  type SpecSelection,
  type ToolCatalog,
  type ToolScope,
} from "./catalog.ts";
import { removeCachedSpec } from "./cache.ts";
import {
  executeOperation,
  getPrompt,
  readResource,
  type CallRequest,
  type CallResult,
  type McpPromptResult,
  type McpResourceResult,
} from "./execute.ts";
import { matchesLabels, normalizeLabels, type LabelMatch } from "./labels.ts";
import { createMcpSession } from "./mcp-client.ts";
import {
  listPrompts,
  listResources,
  type FeatureListOptions,
  type PromptList,
  type ResourceList,
} from "./mcp-features.ts";
import { runOAuthFlow, type OAuthFlowResult } from "./oauth/auth-flow.ts";
import { clearTokenFile, saveTokenFile } from "./oauth/tokens.ts";
import {
  describeOperation,
  describeType,
  grepMatch,
  listOperations,
  listTypes,
  operations as specOperations,
  type GrepMatch,
  type ListOptions,
  type OperationList,
  type SpecTypes,
} from "./operations.ts";
import { allEntries, fileRegistryStore, findEntry, getEntry, putEntry } from "./registry.ts";
import { loadSpec as loadSpecDocument, withAuthFrom, type ConfigOptions } from "./resolve.ts";
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
  StringMap,
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
  interactiveAuth?: boolean;
}

export interface SpecSummary {
  name: string;
  type: RegistryEntry["type"];
  description: string | null;
  enabled: boolean;
  labels?: string[];
}

export interface SpecListOptions {
  filter?: string;
  compact?: boolean;
  labels?: string[];
  match?: LabelMatch;
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

export interface SearchOptions extends PageOptions {
  spec?: SpecSelection;
  labels?: string[];
  match?: LabelMatch;
}

export type SearchHit = GrepMatch & { rank: number; spec: string; type: SpecType };

export interface SearchResult {
  query: string;
  total: number;
  showing: number;
  results: SearchHit[];
  unavailable?: { spec: string; error: string }[];
  offset?: number;
  limit?: number;
}

export interface SpecClient {
  specs: {
    list(options?: SpecListOptions & { compact?: true }): SpecSummary[];
    list(options: SpecListOptions & { compact: false }): NamedEntry[];
    list(options?: SpecListOptions): (SpecSummary | NamedEntry)[];
    get(name: string): NamedEntry;
    add(name: string, source: SpecSource): AddResult;
    remove(name: string): void;
    enable(name: string): void;
    disable(name: string): void;
    addLabels(name: string, labels: string[]): string[];
    removeLabels(name: string, labels: string[]): string[];
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
    search(query: string, options?: SearchOptions): Promise<SearchResult>;
    grep(query: string, options?: SearchOptions): Promise<SearchResult>;
    call(ref: SpecRef, target: string, request?: CallRequest): Promise<CallResult>;
  };
  resources: {
    list(ref: SpecRef, options?: FeatureListOptions): Promise<ResourceList>;
    read(ref: SpecRef, target: string, options?: ResourceReadOptions): Promise<McpResourceResult>;
  };
  prompts: {
    list(ref: SpecRef, options?: FeatureListOptions): Promise<PromptList>;
    get(ref: SpecRef, name: string, options?: PromptGetOptions): Promise<McpPromptResult>;
  };
  tools: ToolCatalog;
  close(): Promise<void>;
}

export interface ResourceReadOptions extends ConfigOptions {
  vars?: StringMap;
}

export interface PromptGetOptions extends ConfigOptions {
  arguments?: Record<string, unknown>;
}

function summary(entry: NamedEntry): SpecSummary {
  return {
    name: entry.name,
    type: entry.type,
    description: entry.description || null,
    enabled: entry.enabled,
    ...(entry.labels?.length ? { labels: entry.labels } : {}),
  };
}

function requireRemoteMcp(entry: NamedEntry) {
  if (entry._section !== "mcp" || entry.type === "stdio")
    throw new Error(
      `'${entry.name}' is not an HTTP/SSE MCP spec — OAuth only applies to mcp http and sse entries`
    );
  return entry;
}

export function createSpecClient(options: SpecClientOptions = {}): SpecClient {
  const store = options.registry ?? fileRegistryStore();
  const session = createMcpSession({ interactiveAuth: options.interactiveAuth });
  const loadDocument = options.loadSpec ?? loadSpecDocument;
  const executeRequest = options.execute ?? executeOperation;
  const load: SpecLoader = (entry, loadOptions) =>
    session.run(() => loadDocument(entry, loadOptions));

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

  function changeLabels(name: string, change: (current: string[]) => string[]): string[] {
    const registry = store.read();
    const entry = findEntry(registry, name);
    if (!entry) throw new Error(`No spec named '${name}'. Run 'spec specs' to see available.`);
    const stored = (registry[entry._section] as Record<string, RegistryEntry>)[name]!;
    const labels = normalizeLabels(change(normalizeLabels(stored.labels)));
    if (labels.length) stored.labels = labels;
    else delete stored.labels;
    store.write(registry);
    return labels;
  }

  function listSpecs({ filter, compact = true, labels, match }: SpecListOptions = {}) {
    const needle = filter?.toLowerCase();
    const wanted = normalizeLabels(labels);
    return allEntries(store.read())
      .filter(
        (entry) =>
          !needle ||
          entry.name.toLowerCase().includes(needle) ||
          (entry.description && entry.description.toLowerCase().includes(needle))
      )
      .filter((entry) => matchesLabels(entry, wanted, match))
      .map((entry) => (compact ? summary(entry) : entry));
  }

  const specs: SpecClient["specs"] = {
    list: listSpecs as SpecClient["specs"]["list"],
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
    addLabels: (name, labels) =>
      changeLabels(name, (current) => [...current, ...normalizeLabels(labels)]),
    removeLabels(name, labels) {
      const removed = new Set(normalizeLabels(labels));
      return changeLabels(name, (current) => current.filter((label) => !removed.has(label)));
    },
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

  const tools = createToolCatalog({
    entries: () => allEntries(store.read()),
    load: (entry) => loadDocument(entry),
    execute: executeRequest,
    scopes: options.scopes,
    session,
  });

  async function search(
    query: string,
    { spec, labels, match, offset = 0, limit = 0 }: SearchOptions = {}
  ): Promise<SearchResult> {
    let names = typeof spec === "string" ? [spec] : spec || [];
    const wanted = normalizeLabels(labels);
    for (const name of names) {
      const entry = getEntry(name, store.read());
      if (!entry.enabled) throw new Error(`Spec '${entry.name}' is disabled. Enable it first.`);
    }
    const enabled = allEntries(store.read()).filter((e) => e.enabled);
    if ((names.length || enabled.length) === 0)
      throw new Error("No registered specs. Run 'spec add' first.");
    if (wanted.length) {
      const candidates = names.length ? names : enabled.map((e) => e.name);
      names = candidates.filter((name) =>
        matchesLabels(findEntry(store.read(), name)!, wanted, match)
      );
      if (names.length === 0) return { query, total: 0, showing: 0, results: [] };
    }
    const searched = names.length || enabled.length;
    const unavailable: { spec: string; error: unknown }[] = [];
    const found = await tools.search(query, names, {
      unavailable: (name, error) => unavailable.push({ spec: name, error }),
    });
    if (unavailable.length === searched) throw unavailable[0]!.error;
    const end = limit > 0 ? offset + limit : undefined;
    const results = found.slice(offset, end).map((tool, position) => ({
      rank: offset + position + 1,
      spec: tool.spec,
      type: tool.document.type,
      ...grepMatch(tool.operation),
    }));
    const result: SearchResult = { query, total: found.length, showing: results.length, results };
    if (offset > 0) result.offset = offset;
    if (limit > 0 && results.length < found.length) result.limit = limit;
    if (unavailable.length > 0)
      result.unavailable = unavailable.map(({ spec: name, error }) => ({
        spec: name,
        error: error instanceof Error ? error.message : String(error),
      }));
    return result;
  }

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
    search,
    grep: search,
    async call(ref, target, request = {}) {
      const { spec, entry } = await loadForRequest(ref, request);
      return await session.run(() => executeRequest(spec, entry, target, request));
    },
  };

  async function loadForRequest(ref: SpecRef, request: ConfigOptions): Promise<LoadedSpec> {
    const entry = withAuthFrom(entryFor(ref), request);
    return { spec: await load(entry), entry };
  }

  const resources: SpecClient["resources"] = {
    async list(ref, listOptions) {
      return listResources((await loadRef(ref)).spec, listOptions);
    },
    async read(ref, target, { vars, ...config } = {}) {
      const { spec, entry } = await loadForRequest(ref, config);
      return await session.run(() => readResource(spec, entry, target, { ...config, vars }));
    },
  };

  const prompts: SpecClient["prompts"] = {
    async list(ref, listOptions) {
      return listPrompts((await loadRef(ref)).spec, listOptions);
    },
    async get(ref, name, { arguments: args, ...config } = {}) {
      const { spec, entry } = await loadForRequest(ref, config);
      return await session.run(() => getPrompt(spec, entry, name, { ...config, data: args }));
    },
  };

  return { specs, operations, resources, prompts, tools, close: session.close };
}

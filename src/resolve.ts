import { flagString, parseKV, type Flags } from "./args.ts";
import { getMetaCache, metaCacheKey, setMetaCache } from "./cache.ts";
import { fetchSpec } from "./fetch.ts";
import { loadTokenFile } from "./oauth/tokens.ts";
import { getEntry } from "./registry.ts";
import {
  authorizationValue,
  envHeaderOverrides,
  envUrlOverride,
  expandSecrets,
  expandSecretsMap,
  hasHeader,
  mergeHeaders,
} from "./secrets.ts";
import { inlineEntryFromFlags } from "./sources.ts";
import { getConfig } from "./store.ts";
import type { LoadedSpec, ResolvedEntry, SpecDocument, StringMap } from "./types.ts";

export interface ConfigOptions {
  auth?: string;
  authFrom?: string;
  baseUrl?: string;
  headers?: StringMap;
}

export interface ResolvedConfig {
  auth: string | null | undefined;
  baseUrl: string | null | undefined;
  headers: StringMap;
}

export const NO_SOURCE_MESSAGE =
  "No spec source. Pass --spec <name> (registered) or an inline flag:\n" +
  "  --openapi <url-or-file>\n" +
  "  --graphql <url>\n" +
  "  --mcp-http <url>\n" +
  "  --mcp-sse <url>\n" +
  '  --mcp-stdio "<cmd args>"';

export function configOptionsFromFlags(flags: Flags): ConfigOptions {
  return {
    auth: flagString(flags, "auth"),
    authFrom: flagString(flags, "auth-from"),
    baseUrl: flagString(flags, "base-url"),
    headers: parseKV(flags.header),
  };
}

function storedAccessToken(name: string): string {
  const access = loadTokenFile(name).tokens?.access_token;
  if (!access) {
    throw new Error(`No access token stored for '${name}'. Run 'spec auth ${name}' first.`);
  }
  return access;
}

export function withAuthFrom<T extends ResolvedEntry | null>(
  entry: T,
  options: Pick<ConfigOptions, "auth" | "authFrom">
): T {
  if (!entry || options.auth || !options.authFrom) return entry;
  const access = storedAccessToken(options.authFrom);
  if (entry._section === "mcp") {
    if (entry.type === "stdio") return entry;
    return { ...entry, headers: { ...(entry.headers || {}), Authorization: `Bearer ${access}` } };
  }
  return { ...entry, config: { ...(entry.config || {}), auth: access } };
}

export function applyAuthFromFlags<T extends ResolvedEntry | null>(entry: T, flags: Flags): T {
  return withAuthFrom(entry, configOptionsFromFlags(flags));
}

export async function loadSpec(
  entry: ResolvedEntry,
  { refresh = false }: { refresh?: boolean } = {}
): Promise<SpecDocument> {
  const key = metaCacheKey(entry);
  const cached = refresh ? null : getMetaCache(key);
  if (cached) return cached;
  const spec = await fetchSpec(entry);
  setMetaCache(key, spec);
  return spec;
}

export function resolveEntry(flags: Flags): ResolvedEntry {
  const name = flagString(flags, "spec");
  const options = configOptionsFromFlags(flags);
  if (name) return withAuthFrom(getEntry(name), options);
  const inline = withAuthFrom(inlineEntryFromFlags(flags), options);
  if (inline) return inline;
  throw new Error(NO_SOURCE_MESSAGE);
}

export async function resolveSpec(flags: Flags): Promise<LoadedSpec> {
  const entry = resolveEntry(flags);
  return { spec: await loadSpec(entry), entry };
}

export function resolveConfig(
  options: ConfigOptions,
  entry?: ResolvedEntry | null
): ResolvedConfig {
  const global = getConfig();
  const entryConfig = entry && entry._section !== "mcp" ? entry.config || {} : {};

  let rawAuth = options.auth || entryConfig.auth || global.auth;
  if (!options.auth && options.authFrom) rawAuth = storedAccessToken(options.authFrom);
  const auth = rawAuth ? expandSecrets(rawAuth) : rawAuth;
  const envUrl = entry?._section === "graphql" ? envUrlOverride() : undefined;
  const baseUrl = options.baseUrl || envUrl || entryConfig.baseUrl || global.baseUrl;

  const headers = expandSecretsMap(
    mergeHeaders(global.headers, entryConfig.headers, envHeaderOverrides(), options.headers)
  );
  if (auth && !hasHeader(headers, "authorization"))
    headers.Authorization = authorizationValue(auth);

  return { auth, baseUrl, headers };
}

import { getEntry, getCachedSpec, saveCachedSpec } from "./registry.js";
import { fetchSpec, inlineEntryFromFlags } from "./commands/fetch.js";
import { getConfig } from "./store.js";
import { parseKV } from "./args.js";
import { loadTokenFile } from "./oauth/tokens.js";
import {
  expandSecrets,
  expandSecretsMap,
  envHeaderOverrides,
  envUrlOverride,
  mergeHeaders,
} from "./secrets.js";

export async function resolveSpec(flags) {
  if (flags.spec) {
    const entry = getEntry(flags.spec);
    let spec = getCachedSpec(flags.spec);
    if (!spec) {
      spec = await fetchSpec(entry);
      saveCachedSpec(flags.spec, spec);
    }
    return { spec, entry };
  }

  const inlineEntry = inlineEntryFromFlags(flags);
  if (inlineEntry) {
    const spec = await fetchSpec(inlineEntry);
    return { spec, entry: inlineEntry };
  }

  throw new Error(
    "No spec source. Pass --spec <name> (registered) or an inline flag:\n" +
      "  --openapi <url-or-file>\n" +
      "  --graphql <url>\n" +
      "  --mcp-http <url>\n" +
      "  --mcp-sse <url>\n" +
      '  --mcp-stdio "<cmd args>"'
  );
}

export function resolveConfig(flags, entry) {
  const global = getConfig();
  const entryConfig = entry?.config || {};
  const callHeaders = parseKV(flags.header);

  let rawAuth = flags.auth || entryConfig.auth || global.auth;
  if (!flags.auth && flags["auth-from"]) {
    const access = loadTokenFile(flags["auth-from"]).tokens?.access_token;
    if (!access) {
      throw new Error(
        `No access token stored for '${flags["auth-from"]}'. Run 'spec auth ${flags["auth-from"]}' first.`
      );
    }
    rawAuth = access;
  }
  const auth = rawAuth ? expandSecrets(rawAuth) : rawAuth;
  const isGraphql = entry?.type === "graphql" || entry?._section === "graphql";
  const envUrl = isGraphql ? envUrlOverride() : undefined;
  const baseUrl = flags["base-url"] || envUrl || entryConfig.baseUrl || global.baseUrl;

  const mergedHeaders = mergeHeaders(
    global.headers,
    entryConfig.headers,
    envHeaderOverrides(),
    callHeaders
  );
  const headers = expandSecretsMap(mergedHeaders);

  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (auth && !hasAuthHeader) {
    headers["Authorization"] =
      auth.startsWith("Bearer ") || auth.startsWith("Basic ") ? auth : `Bearer ${auth}`;
  }

  return { auth, baseUrl, headers };
}

import { getEntry, getCachedSpec, saveCachedSpec } from "./registry.js";
import { fetchSpec, inlineEntryFromFlags } from "./commands/fetch.js";
import { getConfig } from "./store.js";
import { parseKV } from "./args.js";

/**
 * Resolve the active spec from flags.
 * Priority:
 *   1. --spec <name>  → registry (auto-caches on first use)
 *   2. Inline flags   → ad-hoc, no caching
 *   3. Error          → no spec source given
 */
export async function resolveSpec(flags) {
  if (flags.spec) {
    const entry = getEntry(flags.spec);     // throws if missing or disabled
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

/**
 * Build the effective config for a command.
 * Precedence (highest → lowest):
 *   1. Call-time flags: --auth, --base-url, --header k=v
 *   2. Registry entry config
 *   3. .spec-cli/config.json
 */
export function resolveConfig(flags, entry) {
  const global = getConfig();
  const entryConfig = entry?.config || {};
  const callHeaders = parseKV(flags.header);

  const auth = flags.auth || entryConfig.auth || global.auth;
  const baseUrl = flags["base-url"] || entryConfig.baseUrl || global.baseUrl;
  const headers = { ...global.headers, ...(entryConfig.headers || {}), ...callHeaders };

  // Apply auth as Authorization header if not already there (case-insensitive check)
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
  if (auth && !hasAuthHeader) {
    headers["Authorization"] = auth.startsWith("Bearer ") || auth.startsWith("Basic ")
      ? auth
      : `Bearer ${auth}`;
  }

  return { auth, baseUrl, headers };
}

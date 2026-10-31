import { flagList, flagString, parseKV, type Flags } from "./args.ts";
import { authorizationValue, hasHeader } from "./secrets.ts";
import type {
  OAuthFlow,
  RegistryEntry,
  RegistrySection,
  ResolvedEntry,
  SpecSource,
  ToolFilter,
} from "./types.ts";

const SPEC_NAME_RE = /^[a-zA-Z0-9_-]+$/;

export const SOURCE_USAGE =
  'Specify a source: --openapi <url>, --graphql <url>, --mcp-http <url>, --mcp-sse <url>, or --mcp-stdio "<cmd>"';

export function assertSpecName(name: string): void {
  if (!SPEC_NAME_RE.test(name)) {
    throw new Error("Spec name must contain only letters, numbers, hyphens, and underscores.");
  }
}

export function parseCommandLine(raw: string): string[] {
  const parts = (raw.trim() ? raw.match(/(?:[^\s"]+|"[^"]*")+/g) : null)?.map((p) =>
    p.replace(/^"|"$/g, "")
  );
  if (!parts?.length) throw new Error("--mcp-stdio requires a non-empty command string");
  return parts;
}

export function parseCallbackPort(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const port = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--oauth-callback-port must be an integer between 1 and 65535");
  }
  return port;
}

export function sectionOf(source: Pick<SpecSource, "type">): RegistrySection {
  return source.type === "openapi" || source.type === "graphql" ? source.type : "mcp";
}

function toolFilter(source: ToolFilter): ToolFilter {
  return {
    ...(source.allowedTools?.length ? { allowedTools: source.allowedTools } : {}),
    ...(source.disabledTools?.length ? { disabledTools: source.disabledTools } : {}),
  };
}

export function entryFromSource(source: SpecSource): RegistryEntry {
  const base = {
    enabled: true,
    ...(source.description ? { description: source.description } : {}),
  };
  const filter = toolFilter(source);
  switch (source.type) {
    case "openapi":
      return {
        ...base,
        type: "openapi",
        source: source.source,
        config: {
          baseUrl: source.baseUrl || null,
          auth: source.auth || null,
          headers: { ...source.headers },
          ...filter,
        },
      };
    case "graphql":
      return {
        ...base,
        type: "graphql",
        source: source.source,
        config: { auth: source.auth || null, headers: { ...source.headers }, ...filter },
      };
    case "stdio": {
      if (!source.command) throw new Error("--mcp-stdio requires a non-empty command string");
      return {
        ...base,
        ...filter,
        type: "stdio",
        command: source.command,
        args: source.args ?? [],
        ...(source.cwd ? { cwd: source.cwd } : {}),
        ...(source.env && Object.keys(source.env).length ? { env: { ...source.env } } : {}),
      };
    }
    case "http":
    case "sse": {
      const headers = { ...source.headers };
      if (source.auth && !hasHeader(headers, "authorization"))
        headers.Authorization = authorizationValue(source.auth);
      const port = parseCallbackPort(source.oauthCallbackPort);
      return {
        ...base,
        ...filter,
        type: source.type,
        url: source.url,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(source.oauthFlow ? { oauthFlow: source.oauthFlow } : {}),
        ...(source.oauthClientId ? { oauthClientId: source.oauthClientId } : {}),
        ...(port ? { oauthCallbackPort: port } : {}),
      };
    }
    default:
      throw new Error(SOURCE_USAGE);
  }
}

export function resolvedEntry(entry: RegistryEntry, name?: string): ResolvedEntry {
  return { ...entry, ...(name ? { name } : {}), _section: sectionOf(entry) } as ResolvedEntry;
}

export function sourceFromFlags(flags: Flags): SpecSource | null {
  const filter = toolFilter({
    allowedTools: flagList(flags, "allow-tool"),
    disabledTools: flagList(flags, "disable-tool"),
  });
  const description = flagString(flags, "description");
  const auth = flagString(flags, "auth");
  const shared = {
    ...filter,
    ...(description ? { description } : {}),
    ...(auth ? { auth } : {}),
  };
  const headers = parseKV(flags.header);

  if (flags["mcp-stdio"]) {
    const [command, ...args] = parseCommandLine(flagString(flags, "mcp-stdio") ?? "");
    const cwd = flagString(flags, "cwd");
    return {
      ...filter,
      ...(description ? { description } : {}),
      type: "stdio",
      command: command!,
      args,
      ...(cwd ? { cwd } : {}),
      env: parseKV(flags.env),
    };
  }
  for (const type of ["sse", "http"] as const) {
    const url = flagString(flags, `mcp-${type}`);
    if (!url) continue;
    const oauthFlow = flagString(flags, "oauth-flow") as OAuthFlow | undefined;
    const oauthClientId = flagString(flags, "oauth-client-id");
    const oauthClientSecret = flagString(flags, "oauth-client-secret");
    const port = parseCallbackPort(flags["oauth-callback-port"]);
    return {
      ...shared,
      type,
      url,
      headers,
      ...(oauthFlow ? { oauthFlow } : {}),
      ...(oauthClientId ? { oauthClientId } : {}),
      ...(oauthClientSecret ? { oauthClientSecret } : {}),
      ...(port ? { oauthCallbackPort: port } : {}),
    };
  }
  const graphql = flagString(flags, "graphql");
  if (graphql) return { ...shared, type: "graphql", source: graphql, headers };
  const openapi = flagString(flags, "openapi");
  if (openapi) {
    const baseUrl = flagString(flags, "base-url");
    return {
      ...shared,
      type: "openapi",
      source: openapi,
      headers,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }
  return null;
}

export function inlineEntryFromFlags(flags: Flags): ResolvedEntry | null {
  const source = sourceFromFlags(flags);
  return source ? resolvedEntry(entryFromSource(source)) : null;
}

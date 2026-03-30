import { parseArgs } from "../args.js";
import { getEntry } from "../registry.js";
import { clearTokenFile } from "../oauth/tokens.js";
import { runOAuthFlow } from "../oauth/auth-flow.js";
import { out } from "../output.js";

export async function authCmd(args) {
  const { positional, flags } = parseArgs(args);
  const name = positional[0];
  if (!name) throw new Error("Usage: spec auth <name> [--revoke]");

  const entry = getEntry(name);

  if (entry._section !== "mcp" || (entry.type !== "http" && entry.type !== "sse")) {
    throw new Error(
      `'${name}' is not an HTTP/SSE MCP spec — OAuth only applies to mcp http and sse entries`
    );
  }

  if ("revoke" in flags) {
    // revokeAll wipes everything including clientSecret
    clearTokenFile(name, { revokeAll: true });
    out({ ok: true, name, revoked: true });
    return;
  }

  // Clear session tokens but preserve clientSecret so client credentials flow still works
  clearTokenFile(name);

  const { flow } = await runOAuthFlow(name, entry);
  out({ ok: true, name, flow });
}

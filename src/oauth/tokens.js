import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "fs";

let TOKEN_DIR = join(homedir(), "spec-cli-config", "tokens");

export function setTokenDir(dir) {
  TOKEN_DIR = dir;
}

function tokenPath(name) {
  return join(TOKEN_DIR, `${name}.json`);
}

export function loadTokenFile(name) {
  const file = tokenPath(name);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

export function saveTokenFile(name, data) {
  mkdirSync(TOKEN_DIR, { recursive: true });
  const existing = loadTokenFile(name);
  writeFileSync(tokenPath(name), JSON.stringify({ ...existing, ...data }, null, 2));
}

/**
 * Clear session tokens for re-auth.
 * Preserves clientSecret (a permanent credential) unless revokeAll is true.
 * Pass { revokeAll: true } for `spec auth <name> --revoke` to wipe everything.
 */
export function clearTokenFile(name, { revokeAll = false } = {}) {
  const file = tokenPath(name);
  if (!existsSync(file)) return;
  if (revokeAll) {
    rmSync(file);
    return;
  }
  // Keep permanent credentials; wipe session tokens, discovery, and clientInfo
  const existing = loadTokenFile(name);
  if (existing.clientSecret) {
    writeFileSync(tokenPath(name), JSON.stringify({ clientSecret: existing.clientSecret }, null, 2));
  } else {
    rmSync(file);
  }
}

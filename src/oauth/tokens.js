import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "fs";
import { expandSecrets } from "../secrets.js";

let TOKEN_DIR = join(homedir(), "spec-cli-config", "tokens");

export function setTokenDir(dir) {
  TOKEN_DIR = dir;
}

function tokenPath(name) {
  return join(TOKEN_DIR, `${name}.json`);
}

export function getClientSecret(name) {
  const secret = loadTokenFile(name).clientSecret;
  return secret ? expandSecrets(secret) : secret;
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

function writeTokenFile(name, data) {
  mkdirSync(TOKEN_DIR, { recursive: true });
  const file = tokenPath(name);
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export function saveTokenFile(name, data) {
  writeTokenFile(name, { ...loadTokenFile(name), ...data });
}

export function clearTokenFile(name, { revokeAll = false } = {}) {
  const file = tokenPath(name);
  if (!existsSync(file)) return;
  if (revokeAll) {
    rmSync(file);
    return;
  }
  const existing = loadTokenFile(name);
  if (existing.clientSecret) {
    writeTokenFile(name, { clientSecret: existing.clientSecret });
  } else {
    rmSync(file);
  }
}

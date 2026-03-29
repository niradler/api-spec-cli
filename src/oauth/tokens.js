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

export function clearTokenFile(name) {
  const file = tokenPath(name);
  if (existsSync(file)) rmSync(file);
}

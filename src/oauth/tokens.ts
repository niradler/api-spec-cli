import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { expandSecrets } from "../secrets.ts";
import { specHome } from "../paths.ts";

export interface TokenFile {
  clientSecret?: string;
  tokens?: OAuthTokens;
  clientInfo?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
}

let tokenDirOverride: string | undefined;

export function setTokenDir(dir: string | undefined): void {
  tokenDirOverride = dir;
}

function tokenDir(): string {
  return tokenDirOverride ?? join(specHome(), "tokens");
}

function tokenPath(name: string): string {
  if (typeof name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Spec name must contain only letters, numbers, hyphens, and underscores.");
  }
  return join(tokenDir(), `${name}.json`);
}

export function getClientSecret(name: string): string | undefined {
  const secret = loadTokenFile(name).clientSecret;
  return secret ? expandSecrets(secret) : secret;
}

export function loadTokenFile(name: string): TokenFile {
  const file = tokenPath(name);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as TokenFile;
  } catch {
    return {};
  }
}

function writeTokenFile(name: string, data: TokenFile): void {
  const file = tokenPath(name);
  mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export function saveTokenFile(name: string, data: TokenFile): void {
  writeTokenFile(name, { ...loadTokenFile(name), ...data });
}

export function clearTokenFile(name: string, { revokeAll = false } = {}): void {
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

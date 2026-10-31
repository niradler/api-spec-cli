import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StringMap } from "./types.ts";

export interface ProjectConfig {
  baseUrl?: string | null;
  auth?: string | null;
  headers?: StringMap;
  [key: string]: unknown;
}

function storeDir(): string {
  return join(process.cwd(), ".spec-cli");
}

export function readStore<T>(name: string): T | null {
  const file = join(storeDir(), `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

export function writeStore(name: string, data: unknown): void {
  mkdirSync(storeDir(), { recursive: true });
  writeFileSync(join(storeDir(), `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getConfig(): ProjectConfig {
  return readStore<ProjectConfig>("config") || { baseUrl: null, headers: {}, auth: null };
}

export function setConfig(config: ProjectConfig): void {
  writeStore("config", config);
}

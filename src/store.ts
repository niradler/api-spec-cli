import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StringMap } from "./types.ts";

export interface ProjectConfig {
  baseUrl?: string | null;
  auth?: string | null;
  headers?: StringMap;
  [key: string]: unknown;
}

let projectDirOverride: string | null | undefined;

export function setProjectDir(dir: string | null | undefined): void {
  projectDirOverride = dir;
}

function storeDir(): string | null {
  if (projectDirOverride === null) return null;
  return join(projectDirOverride ?? process.cwd(), ".spec-cli");
}

export function readStore<T>(name: string): T | null {
  const dir = storeDir();
  if (!dir) return null;
  const file = join(dir, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

export function writeStore(name: string, data: unknown): void {
  const dir = storeDir();
  if (!dir) throw new Error("Project config is disabled");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function getConfig(): ProjectConfig {
  return readStore<ProjectConfig>("config") || { baseUrl: null, headers: {}, auth: null };
}

export function setConfig(config: ProjectConfig): void {
  writeStore("config", config);
}

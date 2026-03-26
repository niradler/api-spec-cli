// Persistent storage in .spec-cli/ directory (project-local)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DIR = join(process.cwd(), ".spec-cli");

function ensureDir() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function readStore(name) {
  const file = join(DIR, `${name}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

export function writeStore(name, data) {
  ensureDir();
  writeFileSync(join(DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

export function getConfig() {
  return readStore("config") || { baseUrl: null, headers: {}, auth: null };
}

export function setConfig(config) {
  writeStore("config", config);
}

export function getSpec() {
  return readStore("spec");
}

export function saveSpec(spec) {
  writeStore("spec", spec);
}

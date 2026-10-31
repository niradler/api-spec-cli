import YAML from "yaml";
import { encode } from "@toon-format/toon";
import { join } from "node:path";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { specHome } from "./paths.ts";

export type OutputFormat = "json" | "text" | "yaml" | "toon";

const FORMATS: OutputFormat[] = ["json", "text", "yaml", "toon"];
const DEFAULT_MAX_STDOUT = 30000;

let outputFormat: OutputFormat = "toon";
let maxStdout = parseMax(process.env.SPEC_MAX_STDOUT, DEFAULT_MAX_STDOUT);
let resultsDirOverride: string | undefined;

function parseMax(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function setFormat(format: string | undefined): void {
  if (format && FORMATS.includes(format as OutputFormat)) outputFormat = format as OutputFormat;
}

export function setMaxStdout(value: unknown): void {
  maxStdout = parseMax(value, DEFAULT_MAX_STDOUT);
}

export function setResultsDir(dir: string | undefined): void {
  resultsDirOverride = dir;
}

export function getMaxStdout(): number {
  return maxStdout;
}

function resultsDir(): string {
  return resultsDirOverride ?? join(specHome(), "results");
}

function render(data: unknown): string {
  switch (outputFormat) {
    case "yaml":
      return YAML.stringify(data).trimEnd();
    case "toon":
      return encode(data).trimEnd();
    case "text":
      return formatText(data);
    case "json":
    default:
      return JSON.stringify(data, null, 2);
  }
}

function spill(data: unknown): string {
  const dir = resultsDir();
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(dir, `${stamp}-${process.hrtime.bigint()}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
  return file;
}

export function out(data: unknown): void {
  const text = render(data);
  if (maxStdout > 0 && text.length > maxStdout) {
    const path = spill(data);
    console.log(
      render({
        cached: true,
        path,
        bytes: Buffer.byteLength(text),
        hint: `rg <pattern> ${path}`,
      })
    );
    return;
  }
  console.log(text);
}

export function err(message: string): void {
  console.error(`error: ${message}`);
}

function formatText(data: unknown, indent = 0): string {
  if (data === null || data === undefined) return "null";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);
  const pad = "  ".repeat(indent);

  if (Array.isArray(data)) {
    if (data.length === 0) return "(empty)";
    return data
      .map((item, i) => {
        if (typeof item === "object" && item !== null) {
          return `${pad}[${i}]\n${formatText(item, indent + 1)}`;
        }
        return `${pad}- ${item}`;
      })
      .join("\n");
  }

  if (typeof data === "object") {
    return Object.entries(data)
      .map(([key, val]) => {
        if (val === null || val === undefined) return `${pad}${key}: null`;
        if (typeof val === "object") return `${pad}${key}:\n${formatText(val, indent + 1)}`;
        return `${pad}${key}: ${val}`;
      })
      .join("\n");
  }

  return String(data);
}

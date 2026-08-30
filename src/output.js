import YAML from "yaml";
import { encode } from "@toon-format/toon";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, writeFileSync, chmodSync } from "fs";

const DEFAULT_MAX_STDOUT = 30000;

let outputFormat = "toon";
let maxStdout = parseMax(process.env.SPEC_MAX_STDOUT, DEFAULT_MAX_STDOUT);
let resultsDir = join(homedir(), "spec-cli-config", "results");

function parseMax(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function setFormat(format) {
  if (format && ["json", "text", "yaml", "toon"].includes(format)) {
    outputFormat = format;
  }
}

export function setMaxStdout(value) {
  maxStdout = parseMax(value, DEFAULT_MAX_STDOUT);
}

export function setResultsDir(dir) {
  resultsDir = dir;
}

export function getMaxStdout() {
  return maxStdout;
}

function render(data) {
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

function spill(data) {
  mkdirSync(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = join(resultsDir, `${stamp}-${process.hrtime.bigint()}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {}
  return file;
}

export function out(data) {
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

export function err(message) {
  console.error(`error: ${message}`);
}

function formatText(data, indent = 0) {
  if (data === null || data === undefined) return "null";
  if (typeof data === "string") return data;
  if (typeof data === "number" || typeof data === "boolean") return String(data);

  if (Array.isArray(data)) {
    if (data.length === 0) return "(empty)";
    return data
      .map((item, i) => {
        if (typeof item === "object" && item !== null) {
          return `${"  ".repeat(indent)}[${i}]\n${formatText(item, indent + 1)}`;
        }
        return `${"  ".repeat(indent)}- ${item}`;
      })
      .join("\n");
  }

  if (typeof data === "object") {
    return Object.entries(data)
      .map(([key, val]) => {
        if (val === null || val === undefined) return `${"  ".repeat(indent)}${key}: null`;
        if (typeof val === "object") {
          return `${"  ".repeat(indent)}${key}:\n${formatText(val, indent + 1)}`;
        }
        return `${"  ".repeat(indent)}${key}: ${val}`;
      })
      .join("\n");
  }

  return String(data);
}

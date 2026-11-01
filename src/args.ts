import type { StringMap } from "./types.ts";

const REPEATABLE = new Set([
  "query",
  "header",
  "var",
  "env",
  "allow-tool",
  "disable-tool",
  "when",
  "label",
]);
const BOOLEAN = new Set(["all-labels"]);

export type FlagValue = string | boolean | string[];

export interface Flags {
  [key: string]: FlagValue | undefined;
}

export interface ParsedArgs {
  flags: Flags;
  positional: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
  const flags: Flags = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let key: string;
    let value: string | true;
    if (arg.includes("=")) {
      const [name, ...rest] = arg.slice(2).split("=");
      key = name!;
      value = rest.join("=");
    } else {
      key = arg.slice(2);
      const next = args[i + 1];
      value = BOOLEAN.has(key) || next === undefined || next.startsWith("--") ? true : args[++i]!;
    }

    if (REPEATABLE.has(key)) {
      const list = (flags[key] as string[] | undefined) ?? [];
      list.push(value as string);
      flags[key] = list;
    } else {
      flags[key] = value;
    }
  }

  return { flags, positional };
}

export function flagString(flags: Flags, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

export function flagList(flags: Flags, key: string): string[] | undefined {
  const value = flags[key];
  if (value === undefined || typeof value === "boolean") return undefined;
  return Array.isArray(value) ? value : [value];
}

export function flagBool(flags: Flags, key: string): boolean {
  const value = flags[key];
  return value !== undefined && value !== false && value !== "false";
}

export const DEFAULT_PAGE_LIMIT = 20;

export function parseLimit(flags: Flags, fallback = DEFAULT_PAGE_LIMIT): number {
  if (flags.limit === undefined) return fallback;
  const n = parseInt(String(flags.limit), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function parseOffset(flags: Flags): number {
  const n = parseInt(String(flags.offset), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function parseKV(pairs: unknown): StringMap {
  const result: StringMap = {};
  for (const pair of (pairs as unknown[] | undefined) || []) {
    if (typeof pair !== "string") throw new Error(`Invalid key=value: ${pair}`);
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`Invalid key=value: ${pair}`);
    result[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return result;
}

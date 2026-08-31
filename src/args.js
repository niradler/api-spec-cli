// Simple arg parser — no deps needed.
// Supports: --flag value, --flag=value, and positional args
// Repeatable flags (--query, --header, --var) are collected into arrays.

const REPEATABLE = new Set(["query", "header", "var", "env", "allow-tool", "disable-tool", "when"]);

export function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      let key, value;
      if (arg.includes("=")) {
        [key, ...value] = arg.slice(2).split("=");
        value = value.join("=");
      } else {
        key = arg.slice(2);
        const next = args[i + 1];
        if (next === undefined || next.startsWith("--")) {
          value = true;
        } else {
          value = args[++i];
        }
      }

      if (REPEATABLE.has(key)) {
        if (!flags[key]) flags[key] = [];
        flags[key].push(value);
      } else {
        flags[key] = value;
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

export const DEFAULT_PAGE_LIMIT = 20;

export function parseLimit(flags, fallback = DEFAULT_PAGE_LIMIT) {
  if (flags.limit === undefined) return fallback;
  const n = parseInt(flags.limit, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

export function parseOffset(flags) {
  const n = parseInt(flags.offset, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Parse key=value pairs from an array of strings
export function parseKV(pairs) {
  const result = {};
  for (const pair of pairs || []) {
    if (typeof pair !== "string") throw new Error(`Invalid key=value: ${pair}`);
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`Invalid key=value: ${pair}`);
    result[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return result;
}

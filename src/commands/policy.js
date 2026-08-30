import { out } from "../output.js";
import { parseArgs } from "../args.js";
import {
  loadRules,
  readPolicyFile,
  writePolicyFile,
  applyPoliciesPath,
  isServerSpecName,
} from "../policy.js";

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const OPERATORS = new Set(["eq", "prefix", "suffix", "glob", "regex", "in", "exists"]);

function parseWhen(pairs) {
  const when = {};
  for (const pair of pairs || []) {
    const idx = pair.indexOf("=");
    if (idx === -1) throw new Error(`Invalid --when ${pair}. Use key=value or key.op=value`);
    const left = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    const parts = left.split(".");
    const last = parts[parts.length - 1];
    if (parts.length >= 2 && OPERATORS.has(last)) {
      const key = parts.slice(0, -1).join(".");
      if (last === "exists") {
        when[key] = { exists: value !== "false" && value !== "0" };
      } else if (last === "in") {
        when[key] = { in: value.split(",").map((s) => s.trim()) };
      } else {
        when[key] = { [last]: value };
      }
    } else {
      when[left] = value;
    }
  }
  return when;
}

function assertValidPattern(pattern) {
  if (pattern == null || typeof pattern === "string") return;
  if (typeof pattern !== "object" || Array.isArray(pattern)) {
    throw new Error("Matcher must be a string or an object with one operator");
  }
  const ops = [...OPERATORS].filter((key) => pattern[key] != null);
  if (ops.length > 1) {
    throw new Error(`Matcher can only use one operator, got ${ops.join(", ")}`);
  }
  if (pattern.regex != null) {
    try {
      new RegExp(pattern.regex, pattern.flags ?? "i");
    } catch {
      throw new Error(`Invalid regex: ${pattern.regex}`);
    }
  }
}

function normalizeRule(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Rule must be a JSON object");
  }
  const id = raw.id;
  if (!id || !ID_RE.test(id)) {
    throw new Error(
      "Rule id is required and must contain only letters, numbers, hyphens, and underscores."
    );
  }
  const effect = raw.effect || "block";
  if (effect !== "block") throw new Error("effect must be block");
  const hasWhen =
    raw.when != null && typeof raw.when === "object" && Object.keys(raw.when).length > 0;
  if (raw.spec == null && raw.tool == null && !hasWhen) {
    throw new Error("Rule needs at least one matcher: --tool, --spec, or --when");
  }
  assertValidPattern(raw.spec);
  assertValidPattern(raw.tool);
  if (hasWhen) {
    for (const pattern of Object.values(raw.when)) assertValidPattern(pattern);
  }
  const rule = { id, effect };
  if (raw.spec != null) rule.spec = raw.spec;
  if (raw.tool != null) rule.tool = raw.tool;
  if (hasWhen) rule.when = raw.when;
  if (raw.message != null) rule.message = raw.message;
  return rule;
}

function resolveTarget(flags, rule) {
  if (flags.local) return { which: "local", specName: undefined, source: "local" };
  const spec = flags.spec || (typeof rule?.spec === "string" ? rule.spec : null);
  if (isServerSpecName(spec)) return { which: "server", specName: spec, source: `server:${spec}` };
  return { which: "global", specName: undefined, source: "global" };
}

function upsert(which, specName, rule) {
  const { rules } = readPolicyFile(which, specName);
  const next = rules.filter((r) => r.id !== rule.id);
  next.push(rule);
  writePolicyFile(which, next, specName);
}

export async function policyCmd(args) {
  const { flags, positional } = parseArgs(args);
  applyPoliciesPath(flags);
  const action = positional[0] || "list";
  const id = flags.id || positional[1];
  const dest = resolveTarget(flags);

  if (action === "list") {
    const rules = loadRules();
    out({ total: rules.length, rules });
    return;
  }

  if (action === "show") {
    if (!id) throw new Error("Usage: spec policy show <id>");
    const rule = loadRules().find((r) => r.id === id);
    if (!rule) throw new Error(`No policy rule named '${id}'.`);
    out(rule);
    return;
  }

  if (action === "add") {
    let raw;
    if (flags.data) {
      try {
        raw = JSON.parse(flags.data);
      } catch {
        throw new Error("--data must be valid JSON");
      }
      if (id && !raw.id) raw.id = id;
    } else {
      raw = {
        id,
        spec: flags.spec,
        tool: flags.tool,
        message: flags.message,
      };
      if (flags.when?.length) raw.when = parseWhen(flags.when);
    }
    const rule = normalizeRule(raw);
    const addDest = resolveTarget(flags, rule);
    const { rules } = readPolicyFile(addDest.which, addDest.specName);
    const overwritten = rules.some((r) => r.id === rule.id);
    upsert(addDest.which, addDest.specName, rule);
    out({ ok: true, id: rule.id, source: addDest.source, overwritten });
    return;
  }

  if (action === "remove") {
    if (!id) throw new Error("Usage: spec policy remove <id> [--local|--spec <name>]");
    const { rules } = readPolicyFile(dest.which, dest.specName);
    const next = rules.filter((r) => r.id !== id);
    if (next.length === rules.length)
      throw new Error(`No policy rule named '${id}' in ${dest.source} policy.`);
    writePolicyFile(dest.which, next, dest.specName);
    out({ ok: true, id, source: dest.source, deleted: true });
    return;
  }

  if (action === "clear") {
    writePolicyFile(dest.which, [], dest.specName);
    out({ ok: true, source: dest.source, cleared: true });
    return;
  }

  throw new Error("Unknown policy subcommand. Use: list, add, show, remove, clear");
}

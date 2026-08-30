import { homedir } from "os";
import { join, dirname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { matchFilter } from "./glob.js";

const SPEC_NAME_RE = /^[a-zA-Z0-9_-]+$/;

let POLICY_DIR = join(homedir(), "spec-cli-config");
let POLICIES_DIR = null;
let LOCAL_POLICY_FILE = join(process.cwd(), ".spec-cli", "policy.json");

export function setPolicyDir(dir) {
  POLICY_DIR = dir;
}

export function setPoliciesDir(dir) {
  POLICIES_DIR = dir;
}

export function setLocalPolicyFile(file) {
  LOCAL_POLICY_FILE = file;
}

export function globalPolicyPath() {
  return join(POLICY_DIR, "policy.json");
}

export function policiesDir() {
  return POLICIES_DIR || join(POLICY_DIR, "policies");
}

export function serverPolicyPath(name) {
  return join(policiesDir(), `${name}.json`);
}

export function localPolicyPath() {
  return LOCAL_POLICY_FILE;
}

function getNested(obj, path) {
  let current = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function asString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function matchPattern(pattern, value) {
  if (pattern == null) return true;
  const str = asString(value);
  if (typeof pattern === "string") return matchFilter(pattern, str);
  if (typeof pattern !== "object" || Array.isArray(pattern)) return false;

  if (pattern.eq != null) return str.toLowerCase() === asString(pattern.eq).toLowerCase();
  if (pattern.prefix != null)
    return str.toLowerCase().startsWith(asString(pattern.prefix).toLowerCase());
  if (pattern.suffix != null)
    return str.toLowerCase().endsWith(asString(pattern.suffix).toLowerCase());
  if (pattern.glob != null) return matchFilter(pattern.glob, str);
  if (pattern.regex != null) {
    try {
      return new RegExp(pattern.regex, pattern.flags ?? "i").test(str);
    } catch {
      return false;
    }
  }
  if (pattern.in != null) {
    const list = Array.isArray(pattern.in) ? pattern.in : String(pattern.in).split(",");
    return list.some((item) => str.toLowerCase() === asString(item).trim().toLowerCase());
  }
  if (pattern.exists != null) {
    const present = value !== undefined && value !== null;
    return pattern.exists ? present : !present;
  }
  return false;
}

export function matchRule(rule, ctx) {
  if (!rule || typeof rule !== "object") return false;
  if (rule.spec != null) {
    if (!matchPattern(rule.spec, ctx.spec ?? "")) return false;
  }
  if (rule.tool != null) {
    if (!matchPattern(rule.tool, ctx.tool ?? "")) return false;
  }
  if (rule.when && typeof rule.when === "object") {
    for (const [key, pattern] of Object.entries(rule.when)) {
      const actual = getNested(ctx.args || {}, key);
      if (!matchPattern(pattern, actual)) return false;
    }
  }
  return true;
}

export function findBlockingRule(rules, ctx) {
  if (process.env.SPEC_NO_POLICY) return null;
  for (const rule of rules || []) {
    if ((rule.effect || "block") !== "block") continue;
    if (matchRule(rule, ctx)) return rule;
  }
  return null;
}

function parsePolicyFile(file) {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (Array.isArray(data)) return data.filter((r) => r && typeof r === "object");
    if (data && Array.isArray(data.rules))
      return data.rules.filter((r) => r && typeof r === "object");
    return [];
  } catch {
    throw new Error(`Policy file is corrupt: ${file}. Fix or delete it.`);
  }
}

function loadServerRules() {
  const dir = policiesDir();
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter((name) => SPEC_NAME_RE.test(name))
    .sort();
  const rules = [];
  for (const name of names) {
    for (const rule of parsePolicyFile(serverPolicyPath(name))) {
      rules.push({ ...rule, spec: rule.spec ?? name, source: `server:${name}` });
    }
  }
  return rules;
}

export function loadRules() {
  const local = parsePolicyFile(LOCAL_POLICY_FILE).map((rule) => ({ ...rule, source: "local" }));
  const global = parsePolicyFile(globalPolicyPath()).map((rule) => ({ ...rule, source: "global" }));
  return [...local, ...global, ...loadServerRules()];
}

function policyFile(which, specName) {
  if (which === "local") return LOCAL_POLICY_FILE;
  if (which === "server") {
    if (!specName || !SPEC_NAME_RE.test(specName)) {
      throw new Error(
        "Per-spec policy file requires a spec name with only letters, numbers, hyphens, and underscores."
      );
    }
    return serverPolicyPath(specName);
  }
  return globalPolicyPath();
}

export function readPolicyFile(which, specName) {
  const file = policyFile(which, specName);
  return { file, rules: parsePolicyFile(file) };
}

export function writePolicyFile(which, rules, specName) {
  const file = policyFile(which, specName);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ rules }, null, 2) + "\n");
}

export function applyPoliciesPath(flags) {
  if (flags?.["policies-path"]) setPoliciesDir(flags["policies-path"]);
}

export function isServerSpecName(name) {
  return typeof name === "string" && SPEC_NAME_RE.test(name);
}

export function enforcePolicy(ctx) {
  if (process.env.SPEC_NO_POLICY) return;
  const hit = findBlockingRule(loadRules(), ctx);
  if (!hit) return;
  const message = hit.message || "blocked";
  const id = hit.id ? `\nrule: ${hit.id}` : "";
  throw new Error(`blocked by policy: ${message}${id}`);
}

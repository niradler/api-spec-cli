import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { matchFilter } from "./glob.ts";
import { specHome } from "./paths.ts";

export type PolicyPattern =
  | string
  | {
      eq?: unknown;
      prefix?: unknown;
      suffix?: unknown;
      glob?: string;
      regex?: string;
      flags?: string;
      in?: unknown[] | string;
      exists?: boolean;
    };

export interface PolicyRule {
  id?: string;
  effect?: "block" | "allow";
  message?: string;
  spec?: PolicyPattern;
  tool?: PolicyPattern;
  when?: Record<string, PolicyPattern>;
  source?: string;
}

export interface PolicyContext {
  spec?: string;
  tool?: string;
  args?: unknown;
}

export type PolicyScope = "local" | "global" | "server";

const SPEC_NAME_RE = /^[a-zA-Z0-9_-]+$/;

let policyDirOverride: string | undefined;
let policiesDirOverride: string | undefined;
let localPolicyFileOverride: string | undefined;

export function setPolicyDir(dir: string | undefined): void {
  policyDirOverride = dir;
}

export function setPoliciesDir(dir: string | undefined): void {
  policiesDirOverride = dir;
}

export function setLocalPolicyFile(file: string | undefined): void {
  localPolicyFileOverride = file;
}

function policyDir(): string {
  return policyDirOverride ?? specHome();
}

export function globalPolicyPath(): string {
  return join(policyDir(), "policy.json");
}

export function policiesDir(): string {
  return policiesDirOverride || join(policyDir(), "policies");
}

export function serverPolicyPath(name: string): string {
  return join(policiesDir(), `${name}.json`);
}

export function localPolicyPath(): string {
  return localPolicyFileOverride ?? join(process.cwd(), ".spec-cli", "policy.json");
}

function getNested(obj: unknown, path: string): unknown {
  let current = obj;
  for (const part of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asString(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function matchPattern(pattern: PolicyPattern | null | undefined, value: unknown): boolean {
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

export function matchRule(rule: PolicyRule | null | undefined, ctx: PolicyContext): boolean {
  if (!rule || typeof rule !== "object") return false;
  if (rule.spec != null && !matchPattern(rule.spec, ctx.spec ?? "")) return false;
  if (rule.tool != null && !matchPattern(rule.tool, ctx.tool ?? "")) return false;
  if (rule.when && typeof rule.when === "object") {
    for (const [key, pattern] of Object.entries(rule.when)) {
      if (!matchPattern(pattern, getNested(ctx.args || {}, key))) return false;
    }
  }
  return true;
}

export function findBlockingRule(
  rules: PolicyRule[] | null | undefined,
  ctx: PolicyContext
): PolicyRule | null {
  if (process.env.SPEC_NO_POLICY) return null;
  for (const rule of rules || []) {
    if ((rule.effect || "block") !== "block") continue;
    if (matchRule(rule, ctx)) return rule;
  }
  return null;
}

function isRule(value: unknown): value is PolicyRule {
  return Boolean(value) && typeof value === "object";
}

function parsePolicyFile(file: string): PolicyRule[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (Array.isArray(data)) return data.filter(isRule);
    const rules = (data as { rules?: unknown } | null)?.rules;
    return Array.isArray(rules) ? rules.filter(isRule) : [];
  } catch {
    throw new Error(`Policy file is corrupt: ${file}. Fix or delete it.`);
  }
}

function loadServerRules(): PolicyRule[] {
  const dir = policiesDir();
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .filter((name) => SPEC_NAME_RE.test(name))
    .sort();
  return names.flatMap((name) =>
    parsePolicyFile(serverPolicyPath(name)).map((rule) => ({
      ...rule,
      spec: rule.spec ?? name,
      source: `server:${name}`,
    }))
  );
}

export function loadRules(): PolicyRule[] {
  const local = parsePolicyFile(localPolicyPath()).map((rule) => ({ ...rule, source: "local" }));
  const global = parsePolicyFile(globalPolicyPath()).map((rule) => ({
    ...rule,
    source: "global",
  }));
  return [...local, ...global, ...loadServerRules()];
}

function policyFile(which: PolicyScope, specName?: string): string {
  if (which === "local") return localPolicyPath();
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

export function readPolicyFile(
  which: PolicyScope,
  specName?: string
): { file: string; rules: PolicyRule[] } {
  const file = policyFile(which, specName);
  return { file, rules: parsePolicyFile(file) };
}

export function writePolicyFile(which: PolicyScope, rules: PolicyRule[], specName?: string): void {
  const file = policyFile(which, specName);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ rules }, null, 2) + "\n");
}

export function applyPoliciesPath(flags: Record<string, unknown> | undefined): void {
  const path = flags?.["policies-path"];
  if (typeof path === "string" && path) setPoliciesDir(path);
}

export function isServerSpecName(name: unknown): name is string {
  return typeof name === "string" && SPEC_NAME_RE.test(name);
}

export function enforcePolicy(ctx: PolicyContext): void {
  if (process.env.SPEC_NO_POLICY) return;
  const hit = findBlockingRule(loadRules(), ctx);
  if (!hit) return;
  const message = hit.message || "blocked";
  const id = hit.id ? `\nrule: ${hit.id}` : "";
  const source = hit.source ? `\nsource: ${hit.source}` : "";
  throw new Error(`blocked by policy: ${message}${id}${source}`);
}

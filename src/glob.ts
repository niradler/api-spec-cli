import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";

function wildcardMatch(pattern: string, text: string): boolean {
  const glob = pattern.toLowerCase();
  const value = text.toLowerCase();
  let g = 0;
  let v = 0;
  let star = -1;
  let mark = 0;
  while (v < value.length) {
    if (g < glob.length && (glob[g] === "?" || glob[g] === value[v])) {
      g++;
      v++;
    } else if (g < glob.length && glob[g] === "*") {
      star = g++;
      mark = v;
    } else if (star >= 0) {
      g = star + 1;
      v = ++mark;
    } else return false;
  }
  while (glob[g] === "*") g++;
  return g === glob.length;
}

export function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

export function matchGlob(pattern: string, str: string): boolean {
  if (!isGlob(pattern)) return str.toLowerCase().includes(pattern.toLowerCase());
  return wildcardMatch(pattern, str);
}

export function matchTemplate(pattern: string, str: string): boolean {
  if (!UriTemplate.isTemplate(pattern)) return false;
  try {
    return new UriTemplate(pattern.toLowerCase()).match(str.toLowerCase()) !== null;
  } catch {
    return false;
  }
}

export function matchFilter(pattern: string, str: string): boolean {
  if (str.toLowerCase() === pattern.toLowerCase()) return true;
  if (UriTemplate.isTemplate(pattern)) return matchTemplate(pattern, str);
  return isGlob(pattern) && wildcardMatch(pattern, str);
}

export function filterAllows(ids: string[], allowed?: string[], disabled?: string[]): boolean {
  const matches = (patterns: string[], id: string) =>
    patterns.some((pattern) => matchFilter(pattern, id));
  return ids.every(
    (id) => (!allowed?.length || matches(allowed, id)) && !matches(disabled ?? [], id)
  );
}

export function applyToolFilter<T>(
  items: T[],
  name: (item: T) => string,
  allowed?: string[],
  disabled?: string[]
): T[] {
  return items.filter((item) => filterAllows([name(item)], allowed, disabled));
}

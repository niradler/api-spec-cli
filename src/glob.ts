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

export function matchFilter(pattern: string, str: string): boolean {
  if (!isGlob(pattern)) return str.toLowerCase() === pattern.toLowerCase();
  return wildcardMatch(pattern, str);
}

export function applyToolFilter<T>(
  items: T[],
  name: (item: T) => string,
  allowed?: string[],
  disabled?: string[]
): T[] {
  return items.filter((item) => {
    const id = name(item);
    if (allowed?.length && !allowed.some((pattern) => matchFilter(pattern, id))) return false;
    return !disabled?.some((pattern) => matchFilter(pattern, id));
  });
}

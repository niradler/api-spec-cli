function globToRegex(pattern: string): RegExp {
  return new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i"
  );
}

function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}

export function matchGlob(pattern: string, str: string): boolean {
  if (!isGlob(pattern)) return str.toLowerCase().includes(pattern.toLowerCase());
  return globToRegex(pattern).test(str);
}

export function matchFilter(pattern: string, str: string): boolean {
  if (!isGlob(pattern)) return str.toLowerCase() === pattern.toLowerCase();
  return globToRegex(pattern).test(str);
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

function globToRegex(pattern) {
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

/**
 * Search match: plain text = substring, glob chars (* ?) = anchored glob.
 * Used by grep — broad matching is desirable for search.
 */
export function matchGlob(pattern, str) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return str.toLowerCase().includes(pattern.toLowerCase());
  }
  return globToRegex(pattern).test(str);
}

/**
 * Filter match: plain text = exact (case-insensitive), glob chars (* ?) = anchored glob.
 * Used by --allow-tool / --disable-tool — precision is required for whitelists.
 * Use *pattern* for explicit substring matching.
 */
export function matchFilter(pattern, str) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return str.toLowerCase() === pattern.toLowerCase();
  }
  return globToRegex(pattern).test(str);
}

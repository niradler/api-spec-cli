/**
 * Match a string against a glob pattern or a plain substring.
 * - Glob chars (* ?) use regex matching
 * - Plain text uses case-insensitive substring matching
 */
export function matchGlob(pattern, str) {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return str.toLowerCase().includes(pattern.toLowerCase());
  }
  const re = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i"
  );
  return re.test(str);
}

import type { NamedEntry } from "./types.ts";

export type LabelMatch = "any" | "all";

export const LABEL_PATTERN = /^[a-z0-9:=._-]{1,64}$/;
export const MAX_LABELS = 32;

export function isValidLabel(label: unknown): label is string {
  return typeof label === "string" && LABEL_PATTERN.test(label);
}

export function normalizeLabels(labels: unknown): string[] {
  if (labels === undefined || labels === null) return [];
  if (!Array.isArray(labels)) throw new Error("Labels must be an array of strings");
  for (const label of labels) {
    if (!isValidLabel(label))
      throw new Error(
        `Invalid label '${String(label)}': use 1-64 characters from a-z 0-9 : = . _ -`
      );
  }
  const unique = [...new Set(labels as string[])].sort();
  if (unique.length > MAX_LABELS)
    throw new Error(`Too many labels (${unique.length}): at most ${MAX_LABELS} per spec`);
  return unique;
}

export function matchesLabels(
  entry: Pick<NamedEntry, "labels">,
  wanted: readonly string[] | undefined,
  match: LabelMatch = "any"
): boolean {
  if (match !== "any" && match !== "all")
    throw new Error(`Invalid label match '${String(match)}': use any or all`);
  if (wanted === undefined) return true;
  const have = Array.isArray(entry.labels) ? entry.labels : [];
  const carried = (label: string) => have.includes(label);
  return wanted.length > 0 && (match === "all" ? wanted.every(carried) : wanted.some(carried));
}

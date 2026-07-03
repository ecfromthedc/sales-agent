// Pure formatting helpers used across pitch/proposal rendering.
// Kept dependency-free and side-effect-free so they're trivially unit-testable.

/** Truncate to `max` chars, appending an ellipsis when cut. */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  if (max <= 1) return "…";
  return s.slice(0, max - 1).trimEnd() + "…";
}

/** URL/branch-safe slug: lowercase, alnum, single dashes. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}


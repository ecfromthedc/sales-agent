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

/** Format a number as whole-dollar USD (no cents). */
export function formatUSD(n: number): string {
  const v = Math.round(Number.isFinite(n) ? n : 0);
  return "$" + v.toLocaleString("en-US");
}

/** Clamp a number into [min, max]. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

/** Compact follower/listener counts: 12_500 -> "12.5K", 2_400_000 -> "2.4M". */
export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

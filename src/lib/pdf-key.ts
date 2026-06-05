// Pure helpers for the pitch-PDF storage path.
//
// Kept dependency-free and side-effect-free so they're trivially unit-testable
// (no browser, no R2, no clock unless injected). The Browser Rendering + R2
// wiring lives in src/integrations/pdf.ts and consumes these.

import { slugify } from "./format";

const PITCH_PREFIX = "pitches";

/**
 * Build the stable R2 object key for a rendered pitch PDF.
 *
 *   pitchPdfKey("abc-123", 1717599600000) -> "pitches/abc-123/1717599600000.pdf"
 *
 * The deal id is slug-sanitized so an unexpected id (e.g. one carrying a slash
 * or whitespace) can never escape the `pitches/` prefix or corrupt the key.
 * The timestamp keeps successive renders for the same deal from clobbering each
 * other while remaining sortable.
 *
 * @param dealId   Notion deal id (or any opaque deal identifier).
 * @param timestamp Epoch millis; defaults to `Date.now()`. Inject for tests.
 */
export function pitchPdfKey(dealId: string, timestamp: number = Date.now()): string {
  const safeId = slugify(dealId) || "unknown";
  const ts = Number.isFinite(timestamp) ? Math.trunc(timestamp) : Date.now();
  return `${PITCH_PREFIX}/${safeId}/${ts}.pdf`;
}

/**
 * Placeholder key used when Browser Rendering is unavailable (binding not
 * configured, local dev, or a render failure). Distinct `pending-` marker so
 * downstream code / dashboards can tell a real PDF from a not-yet-rendered one.
 */
export function pendingPitchPdfKey(dealId: string, timestamp: number = Date.now()): string {
  const safeId = slugify(dealId) || "unknown";
  const ts = Number.isFinite(timestamp) ? Math.trunc(timestamp) : Date.now();
  return `${PITCH_PREFIX}/${safeId}/pending-${ts}.pdf`;
}

/** True when a key was produced by the pending/fallback path. */
export function isPendingPitchKey(key: string): boolean {
  const file = key.split("/").pop() ?? "";
  return file.startsWith("pending-");
}

/**
 * Finalize composed HTML into a complete, self-contained document ready for
 * `page.setContent`. If the model already returned a full `<!DOCTYPE html>`
 * document we pass it through untouched; otherwise we wrap the fragment in a
 * minimal HTML5 shell so Browser Rendering has a valid root to print.
 */
export function finalizePitchHtml(html: string): string {
  const trimmed = (html ?? "").trim();
  if (/<!doctype html/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    return trimmed;
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    '<head><meta charset="utf-8" /></head>',
    `<body>${trimmed}</body>`,
    "</html>",
  ].join("\n");
}

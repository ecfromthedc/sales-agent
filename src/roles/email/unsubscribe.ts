/**
 * src/roles/email/unsubscribe.ts — pure extraction of unsubscribe options.
 *
 * PURE + DETERMINISTIC: no I/O, no network, no Node APIs. Same input → same
 * output. Workers-compatible. Parses RFC 2369 `List-Unsubscribe` and RFC 8058
 * `List-Unsubscribe-Post` headers into a structured {@link UnsubscribeOptions}.
 *
 * ⚠️ EXTRACTION ONLY — NEVER ACTIONS THE UNSUBSCRIBE (SALE-121).
 *   This module does NOT fetch, POST, open a mailto, or perform any unsubscribe.
 *   It only *detects and describes* the options an email exposes. A human must
 *   approve before any unsubscribe is ever performed; actually actioning an
 *   unsubscribe (the RFC 8058 one-click POST, the mailto send, or following the
 *   plain URL) is a FUTURE ticket gated behind the approval flow. Do not add
 *   network calls here.
 *
 * Reuse note: the `headers` shape is the same case-insensitive
 * `Record<string, string>` map used by `triage.ts` / `inbox.ts`.
 */

/** A `mailto:` unsubscribe option, with an optional parsed `subject`. */
export interface MailtoUnsubscribe {
  /** Bare destination address (the part after `mailto:`, before any `?`). */
  address: string;
  /** `subject` query param, if present and non-empty. */
  subject?: string;
}

/** A one-click (RFC 8058) unsubscribe option: an https URL safe to POST to. */
export interface OneClickUnsubscribe {
  /** https URL to which a `List-Unsubscribe=One-Click` body would be POSTed. */
  url: string;
}

/** Structured view of the unsubscribe options an email exposes. */
export interface UnsubscribeOptions {
  /**
   * Present iff RFC 8058 one-click is offered: a `List-Unsubscribe-Post:
   * List-Unsubscribe=One-Click` header AND an https URL in `List-Unsubscribe`.
   */
  oneClick?: OneClickUnsubscribe;
  /** A `mailto:` unsubscribe option, if one is listed. */
  mailto?: MailtoUnsubscribe;
  /** A plain https unsubscribe URL, if one is listed. */
  url?: string;
  /** The raw, untouched `List-Unsubscribe` header value (for audit). */
  raw: string;
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Case-insensitive lookup over an arbitrary-cased header map. */
function getHeader(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) {
      const v = headers[key];
      return typeof v === "string" ? v : "";
    }
  }
  return "";
}

/**
 * Split a `List-Unsubscribe` value into its individual URIs, stripping the
 * angle brackets. Items are `<...>`-wrapped and comma-separated; we extract the
 * content of each bracket pair, so commas *inside* a mailto query (e.g.
 * `?subject=a,b`) never split an item — only the commas BETWEEN bracketed
 * items matter.
 */
function extractBracketedUris(value: string): string[] {
  const uris: string[] = [];
  const re = /<([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    const uri = m[1].trim();
    if (uri.length > 0) uris.push(uri);
  }
  return uris;
}

/**
 * Parse a `mailto:` URI into address + optional subject.
 *
 * `mailto:abuse@x.com?subject=unsubscribe%20me&body=...` →
 *   { address: "abuse@x.com", subject: "unsubscribe me" }
 *
 * Does NOT use the URL constructor: `mailto:` is parsed manually so behavior is
 * identical across runtimes and never throws on odd inputs.
 */
function parseMailto(uri: string): MailtoUnsubscribe | null {
  // Case-insensitive scheme check; preserve original casing of the address.
  if (!/^mailto:/i.test(uri)) return null;
  const afterScheme = uri.slice("mailto:".length);
  const qIdx = afterScheme.indexOf("?");
  const address = (qIdx === -1 ? afterScheme : afterScheme.slice(0, qIdx)).trim();
  if (address.length === 0) return null;

  const result: MailtoUnsubscribe = { address };

  if (qIdx !== -1) {
    const query = afterScheme.slice(qIdx + 1);
    for (const pair of query.split("&")) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const key = pair.slice(0, eq);
      if (key.toLowerCase() !== "subject") continue;
      const rawVal = pair.slice(eq + 1);
      const subject = safeDecode(rawVal).trim();
      if (subject.length > 0) result.subject = subject;
      break;
    }
  }

  return result;
}

/** Decode a percent-encoded query value; fall back to the raw value on error. */
function safeDecode(value: string): string {
  // `+` is a space in form-encoded query strings.
  const plusAsSpace = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(plusAsSpace);
  } catch {
    return plusAsSpace;
  }
}

/** True for an `https://` URI (case-insensitive scheme). */
function isHttpsUrl(uri: string): boolean {
  return /^https:\/\//i.test(uri);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the unsubscribe options exposed by an email's headers.
 *
 * PURE: no network, no side effects — see the file-level doc comment. This
 * DETECTS options only; it never performs the unsubscribe.
 *
 * @param headers case-insensitive header map (same shape as `triage.ts`).
 * @returns structured {@link UnsubscribeOptions}, or `null` when there is no
 *          `List-Unsubscribe` header (or it lists no usable URIs).
 */
export function extractUnsubscribe(
  headers: Record<string, string>,
): UnsubscribeOptions | null {
  const raw = getHeader(headers, "List-Unsubscribe");
  if (raw.trim().length === 0) return null;

  const uris = extractBracketedUris(raw);
  if (uris.length === 0) return null;

  // RFC 8058: one-click is only valid when the post header explicitly opts in.
  const post = getHeader(headers, "List-Unsubscribe-Post");
  const oneClickEnabled = /list-unsubscribe\s*=\s*one-click/i.test(post);

  let mailto: MailtoUnsubscribe | undefined;
  let url: string | undefined;

  for (const uri of uris) {
    if (/^mailto:/i.test(uri)) {
      if (!mailto) {
        const parsed = parseMailto(uri);
        if (parsed) mailto = parsed;
      }
    } else if (isHttpsUrl(uri)) {
      // First https URL wins as the plain-URL option.
      if (!url) url = uri;
    }
    // Other schemes (http, etc.) are ignored: one-click requires https,
    // and we don't surface insecure unsubscribe URLs.
  }

  const result: UnsubscribeOptions = { raw };

  if (oneClickEnabled && url) {
    result.oneClick = { url };
  }
  if (mailto) result.mailto = mailto;
  if (url) result.url = url;

  // If nothing usable was parsed (e.g. only unsupported schemes), still return
  // the raw value so callers can audit — but only when we found at least one
  // recognized option. Otherwise treat as no actionable unsubscribe.
  if (!result.oneClick && !result.mailto && !result.url) return null;

  return result;
}

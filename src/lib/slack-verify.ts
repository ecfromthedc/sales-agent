/**
 * Slack request verification — pure, Workers-compatible helpers.
 *
 * These gate the public `/slack/events` endpoint (the proposal refine loop),
 * so they are security-critical. Kept dependency-free and side-effect-free so
 * they can be unit-tested in isolation and reused by any Slack-facing trigger.
 *
 * Implements Slack's v0 signing scheme:
 *   https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * sig_basestring = "v0:{timestamp}:{rawBody}"
 * expected       = "v0=" + hex( HMAC-SHA256(signing_secret, sig_basestring) )
 * valid          = constant-time-eq(expected, X-Slack-Signature)
 *                  AND |now - timestamp| <= 5 minutes  (replay protection)
 *
 * Uses Web Crypto (`crypto.subtle`) — no Node `crypto` — so it runs on
 * Cloudflare Workers and in the Node test runner alike.
 */

/** Slack's replay window, in seconds. Requests older than this are rejected. */
export const SLACK_MAX_SKEW_SECONDS = 60 * 5;

/**
 * True iff the request timestamp is within {@link SLACK_MAX_SKEW_SECONDS} of
 * `nowSeconds`. Rejects empty, non-numeric, or stale timestamps. `nowSeconds`
 * is injectable for deterministic tests; defaults to the wall clock.
 */
export function isFreshTimestamp(
  timestamp: string | null | undefined,
  nowSeconds: number = Date.now() / 1000,
): boolean {
  if (!timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(nowSeconds - ts);
  if (!Number.isFinite(age)) return false;
  return age <= SLACK_MAX_SKEW_SECONDS;
}

/**
 * Constant-time string comparison. Returns false immediately on length
 * mismatch (length is not secret here — the hex digest length is fixed), then
 * XOR-accumulates over the full string so the compare time does not depend on
 * where the first differing byte is.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** Hex-encode bytes (lowercase, zero-padded), matching Slack's digest format. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compute the expected `v0=...` Slack signature for a request body.
 * Pure given (secret, timestamp, rawBody); does no header/clock work.
 */
export async function computeSlackSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${timestamp}:${rawBody}`));
  return "v0=" + toHex(mac);
}

/**
 * Full verification: signing secret present, headers present, timestamp fresh,
 * and the v0 HMAC matches in constant time. Fail-closed — any missing input
 * returns false. `nowSeconds` is injectable for tests.
 */
export async function verifySlackRequest(params: {
  secret: string | undefined | null;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const { secret, timestamp, signature, rawBody, nowSeconds } = params;
  if (!secret) return false;
  if (!timestamp || !signature) return false;
  if (!isFreshTimestamp(timestamp, nowSeconds ?? Date.now() / 1000)) return false;

  const expected = await computeSlackSignature(secret, timestamp, rawBody);
  return timingSafeEqual(expected, signature);
}

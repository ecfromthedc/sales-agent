/**
 * Pure, dependency-free security primitives for the proposal pipeline.
 *
 * These two functions guard the public surface of the proposal flow:
 *   - verifyFirefliesSignature: authenticates inbound Fireflies webhooks
 *     (HMAC-SHA256 over the raw body, timing-safe compared against the
 *     x-hub-signature header).
 *   - isValidDealId: the path-guard for GET /p/:dealId — the dealId is an
 *     opaque Notion UUID acting as a capability token, so we only ever serve
 *     R2 objects whose key segment is a plain id (no slashes/dots/traversal).
 *
 * Kept here, isolated and import-free, so the security-critical logic is unit
 * testable without dragging in Worker bindings or the proposal drafter.
 * Workers-compatible: uses WebCrypto (crypto.subtle), no Node APIs.
 */

/**
 * Path-guard for the public proposal viewer. A valid dealId is a non-empty
 * string of ASCII letters, digits, and hyphens only — exactly the shape of a
 * Notion page UUID. Anything else (slashes, dots, ".." traversal, encoded
 * separators, empty) is rejected so it can never reach the R2 key
 * `proposals/${dealId}/latest.html`.
 */
export function isValidDealId(dealId: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(dealId);
}

/**
 * Verify a Fireflies webhook signature.
 *
 * @param payload   the raw request body (verify BEFORE JSON.parse)
 * @param signature the x-hub-signature header value (lowercase hex HMAC)
 * @param secret    FIREFLIES_WEBHOOK_SECRET
 * @returns true only when the signature is a valid HMAC-SHA256 of payload.
 *
 * Comparison is timing-safe: length is checked first, then every character is
 * XOR-accumulated so the loop does not short-circuit on the first mismatch.
 */
export async function verifyFirefliesSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const expected = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Timing-safe comparison — length check first, then constant-time scan.
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Calendly webhook signature verification.
 * See: https://developer.calendly.com/api-docs/ZG9jOjE1OTI5MjAw-webhook-signatures
 *
 * Header: `Calendly-Webhook-Signature: t=<timestamp>,v1=<hex_hmac>`
 * Payload to sign: `${timestamp}.${rawBody}`
 * Algorithm: HMAC-SHA256 with the signing key.
 */

export async function verifyCalendlySignature(
  rawBody: string,
  header: string,
  signingKey: string,
): Promise<boolean> {
  if (!header || !signingKey) return false;

  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  // Reject signatures older than 5 minutes (replay protection).
  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (ageSec > 300) return false;

  const payload = `${timestamp}.${rawBody}`;
  const expected = await hmacSha256Hex(signingKey, payload);

  return timingSafeEqualHex(expected, v1);
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

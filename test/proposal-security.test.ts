import { describe, it, expect } from "vitest";
import {
  isValidDealId,
  verifyFirefliesSignature,
} from "../src/lib/proposal-security";

/**
 * Reference HMAC-SHA256 helper for the tests — independent of the production
 * implementation, so the tests verify behavior rather than echo the code.
 */
async function hmacHex(payload: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("isValidDealId — proposal path guard", () => {
  it("accepts a Notion-style UUID", () => {
    expect(isValidDealId("1f2a3b4c-5d6e-7f80-9a1b-2c3d4e5f6a7b")).toBe(true);
  });

  it("accepts plain alphanumeric ids", () => {
    expect(isValidDealId("abc123")).toBe(true);
    expect(isValidDealId("DEAL-42")).toBe(true);
    expect(isValidDealId("a")).toBe(true);
  });

  it("rejects the empty string", () => {
    expect(isValidDealId("")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isValidDealId("..")).toBe(false);
    expect(isValidDealId("../secret")).toBe(false);
    expect(isValidDealId("../../etc/passwd")).toBe(false);
  });

  it("rejects slashes that would escape the R2 key prefix", () => {
    expect(isValidDealId("a/b")).toBe(false);
    expect(isValidDealId("deal/latest.html")).toBe(false);
    expect(isValidDealId("/leading")).toBe(false);
    expect(isValidDealId("trailing/")).toBe(false);
  });

  it("rejects dots (no file-extension tricks)", () => {
    expect(isValidDealId("deal.html")).toBe(false);
    expect(isValidDealId("deal.")).toBe(false);
  });

  it("rejects encoded separators and other unsafe characters", () => {
    expect(isValidDealId("deal%2Fevil")).toBe(false);
    expect(isValidDealId("deal\\evil")).toBe(false);
    expect(isValidDealId("deal id")).toBe(false);
    expect(isValidDealId("deal?x=1")).toBe(false);
    expect(isValidDealId("deal#frag")).toBe(false);
    expect(isValidDealId("deal\n")).toBe(false);
    expect(isValidDealId("déal")).toBe(false);
  });
});

describe("verifyFirefliesSignature — webhook HMAC auth", () => {
  const secret = "fireflies-webhook-secret-abc123";
  const payload = JSON.stringify({
    meetingId: "M-1",
    eventType: "Transcription completed",
  });

  it("accepts a correctly signed payload", async () => {
    const sig = await hmacHex(payload, secret);
    expect(await verifyFirefliesSignature(payload, sig, secret)).toBe(true);
  });

  it("rejects an empty signature header", async () => {
    expect(await verifyFirefliesSignature(payload, "", secret)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const sig = await hmacHex(payload, "wrong-secret");
    expect(await verifyFirefliesSignature(payload, sig, secret)).toBe(false);
  });

  it("rejects when the payload was tampered with after signing", async () => {
    const sig = await hmacHex(payload, secret);
    const tampered = payload.replace("M-1", "M-2");
    expect(await verifyFirefliesSignature(tampered, sig, secret)).toBe(false);
  });

  it("rejects a signature of the wrong length (no truncation bypass)", async () => {
    const sig = await hmacHex(payload, secret);
    expect(await verifyFirefliesSignature(payload, sig.slice(0, -2), secret)).toBe(
      false,
    );
    expect(await verifyFirefliesSignature(payload, sig + "ab", secret)).toBe(
      false,
    );
  });

  it("rejects a single-bit-flipped signature of correct length", async () => {
    const sig = await hmacHex(payload, secret);
    const last = sig[sig.length - 1];
    const flipped = sig.slice(0, -1) + (last === "0" ? "1" : "0");
    expect(await verifyFirefliesSignature(payload, flipped, secret)).toBe(false);
  });

  it("rejects garbage that is not hex at all", async () => {
    expect(
      await verifyFirefliesSignature(payload, "not-a-real-signature", secret),
    ).toBe(false);
  });

  it("is deterministic — same inputs verify the same way twice", async () => {
    const sig = await hmacHex(payload, secret);
    expect(await verifyFirefliesSignature(payload, sig, secret)).toBe(true);
    expect(await verifyFirefliesSignature(payload, sig, secret)).toBe(true);
  });
});

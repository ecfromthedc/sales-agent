import { describe, it, expect } from "vitest";
import {
  SLACK_MAX_SKEW_SECONDS,
  isFreshTimestamp,
  timingSafeEqual,
  computeSlackSignature,
  verifySlackRequest,
} from "../src/lib/slack-verify";

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BODY = JSON.stringify({ type: "event_callback", event: { text: "make tier 2 $8k" } });
// A fixed instant so every signed fixture is reproducible.
const NOW = 1_700_000_000; // seconds

describe("isFreshTimestamp — 5-minute replay window", () => {
  it("accepts the exact current second", () => {
    expect(isFreshTimestamp(String(NOW), NOW)).toBe(true);
  });

  it("accepts a timestamp at the edge of the window (±300s)", () => {
    expect(isFreshTimestamp(String(NOW - SLACK_MAX_SKEW_SECONDS), NOW)).toBe(true);
    expect(isFreshTimestamp(String(NOW + SLACK_MAX_SKEW_SECONDS), NOW)).toBe(true);
  });

  it("rejects a stale timestamp just past the window (replay)", () => {
    expect(isFreshTimestamp(String(NOW - SLACK_MAX_SKEW_SECONDS - 1), NOW)).toBe(false);
  });

  it("rejects a far-future timestamp (clock spoof)", () => {
    expect(isFreshTimestamp(String(NOW + 3600), NOW)).toBe(false);
  });

  it("rejects empty, null, and non-numeric timestamps (fail-closed)", () => {
    expect(isFreshTimestamp("", NOW)).toBe(false);
    expect(isFreshTimestamp(null, NOW)).toBe(false);
    expect(isFreshTimestamp(undefined, NOW)).toBe(false);
    expect(isFreshTimestamp("not-a-number", NOW)).toBe(false);
  });

  it("uses the wall clock when nowSeconds is omitted", () => {
    expect(isFreshTimestamp(String(Date.now() / 1000))).toBe(true);
    expect(isFreshTimestamp("1")).toBe(false); // 1970 → stale
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("v0=abc123", "v0=abc123")).toBe(true);
  });

  it("returns false on any byte difference of equal length", () => {
    expect(timingSafeEqual("v0=abc123", "v0=abc124")).toBe(false);
  });

  it("returns false on length mismatch without throwing", () => {
    expect(timingSafeEqual("v0=abc", "v0=abc123")).toBe(false);
    expect(timingSafeEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("computeSlackSignature — Slack v0 HMAC-SHA256", () => {
  it("produces a lowercase hex digest prefixed with v0=", async () => {
    const sig = await computeSlackSignature(SECRET, String(NOW), BODY);
    expect(sig).toMatch(/^v0=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same (secret, timestamp, body)", async () => {
    const a = await computeSlackSignature(SECRET, String(NOW), BODY);
    const b = await computeSlackSignature(SECRET, String(NOW), BODY);
    expect(a).toBe(b);
  });

  it("changes when the body changes", async () => {
    const a = await computeSlackSignature(SECRET, String(NOW), BODY);
    const b = await computeSlackSignature(SECRET, String(NOW), BODY + " ");
    expect(a).not.toBe(b);
  });

  it("changes when the timestamp changes (basestring binds the timestamp)", async () => {
    const a = await computeSlackSignature(SECRET, String(NOW), BODY);
    const b = await computeSlackSignature(SECRET, String(NOW + 1), BODY);
    expect(a).not.toBe(b);
  });

  it("changes when the signing secret changes", async () => {
    const a = await computeSlackSignature(SECRET, String(NOW), BODY);
    const b = await computeSlackSignature(SECRET + "x", String(NOW), BODY);
    expect(a).not.toBe(b);
  });

  it("matches a known-answer vector from Slack's own docs", async () => {
    // Slack's published example (api.slack.com/authentication/verifying-requests-from-slack):
    // secret, timestamp, and body below produce exactly this v0 signature.
    const docSecret = "8f742231b10e8888abcd99yyyzzz85a5";
    const docTs = "1531420618";
    const docBody =
      "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    const sig = await computeSlackSignature(docSecret, docTs, docBody);
    expect(sig).toBe("v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503");
  });
});

describe("verifySlackRequest — end-to-end gate", () => {
  async function signedHeaders(body: string, ts: number) {
    const timestamp = String(ts);
    const signature = await computeSlackSignature(SECRET, timestamp, body);
    return { timestamp, signature };
  }

  it("accepts a correctly signed, fresh request", async () => {
    const { timestamp, signature } = await signedHeaders(BODY, NOW);
    const ok = await verifySlackRequest({ secret: SECRET, timestamp, signature, rawBody: BODY, nowSeconds: NOW });
    expect(ok).toBe(true);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const { timestamp, signature } = await signedHeaders(BODY, NOW);
    const ok = await verifySlackRequest({
      secret: SECRET,
      timestamp,
      signature,
      rawBody: BODY + "tampered",
      nowSeconds: NOW,
    });
    expect(ok).toBe(false);
  });

  it("rejects a valid signature replayed outside the freshness window", async () => {
    const { timestamp, signature } = await signedHeaders(BODY, NOW);
    // Same signature, but 'now' has moved 6 minutes forward.
    const ok = await verifySlackRequest({
      secret: SECRET,
      timestamp,
      signature,
      rawBody: BODY,
      nowSeconds: NOW + 6 * 60,
    });
    expect(ok).toBe(false);
  });

  it("rejects a request signed with a different secret", async () => {
    const timestamp = String(NOW);
    const signature = await computeSlackSignature("wrong-secret", timestamp, BODY);
    const ok = await verifySlackRequest({ secret: SECRET, timestamp, signature, rawBody: BODY, nowSeconds: NOW });
    expect(ok).toBe(false);
  });

  it("fails closed when the signing secret is missing", async () => {
    const { timestamp, signature } = await signedHeaders(BODY, NOW);
    for (const secret of ["", null, undefined]) {
      const ok = await verifySlackRequest({ secret, timestamp, signature, rawBody: BODY, nowSeconds: NOW });
      expect(ok).toBe(false);
    }
  });

  it("fails closed when the timestamp or signature header is absent", async () => {
    const { timestamp, signature } = await signedHeaders(BODY, NOW);
    expect(
      await verifySlackRequest({ secret: SECRET, timestamp: null, signature, rawBody: BODY, nowSeconds: NOW }),
    ).toBe(false);
    expect(
      await verifySlackRequest({ secret: SECRET, timestamp, signature: null, rawBody: BODY, nowSeconds: NOW }),
    ).toBe(false);
  });
});

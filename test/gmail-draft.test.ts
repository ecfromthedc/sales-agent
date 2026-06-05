import { describe, it, expect } from "vitest";
import { buildMimeMessage, base64UrlEncode } from "../src/integrations/gmail";

// These lock the pure pieces behind Gmail DRAFT creation (SALE-63). The draft
// is an approval gate: a human reviews and sends. The MIME builder must emit a
// well-formed plain-text message with the standard headers and NOTHING that
// would cause Gmail to dispatch it (no send/Bcc/auto-send fields).
describe("buildMimeMessage", () => {
  const base = {
    to: "artist@label.com",
    from: "Eric Cromartie <ec@risingtidesent.com>",
    subject: "Following up: Strategy Session",
    body: "Hey — great talking. Here's the recap.",
  };

  it("includes the required RFC822 headers", () => {
    const mime = buildMimeMessage(base);
    expect(mime).toContain("From: Eric Cromartie <ec@risingtidesent.com>");
    expect(mime).toContain("To: artist@label.com");
    expect(mime).toContain("Subject: Following up: Strategy Session");
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
  });

  it("separates headers from body with a blank CRLF line", () => {
    const mime = buildMimeMessage(base);
    const [headers, ...rest] = mime.split("\r\n\r\n");
    expect(headers).toContain("Subject:");
    expect(rest.join("\r\n\r\n")).toBe(base.body);
  });

  it("preserves the body verbatim", () => {
    const mime = buildMimeMessage(base);
    expect(mime.endsWith(base.body)).toBe(true);
  });

  it("does NOT include any send / Bcc / auto-send headers (draft only)", () => {
    const mime = buildMimeMessage(base).toLowerCase();
    expect(mime).not.toContain("bcc:");
    expect(mime).not.toContain("x-send");
    expect(mime).not.toContain("send-now");
    expect(mime).not.toContain("auto-send");
  });

  it("strips CR/LF from header values to prevent header injection", () => {
    const mime = buildMimeMessage({
      ...base,
      subject: "Hi\r\nBcc: attacker@evil.com",
    });
    // The injected header must be folded into the Subject value, not become a
    // real Bcc header.
    expect(mime).toContain("Subject: Hi Bcc: attacker@evil.com");
    expect(mime).not.toMatch(/\r\nBcc:/);
  });
});

describe("base64UrlEncode", () => {
  it("produces URL-safe base64 with no padding", () => {
    const encoded = base64UrlEncode("subjects??>>");
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("round-trips ASCII via the standard atob", () => {
    const text = "From: a@b.com\r\n\r\nhello";
    const encoded = base64UrlEncode(text);
    const restored = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    expect(restored).toBe(text);
  });

  it("handles UTF-8 (accents/emoji) without corruption", () => {
    const text = "café — 🎵";
    const encoded = base64UrlEncode(text);
    const restoredBytes = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    const restored = decodeURIComponent(escape(restoredBytes));
    expect(restored).toBe(text);
  });
});

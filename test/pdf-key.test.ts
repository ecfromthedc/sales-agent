import { describe, it, expect } from "vitest";
import {
  pitchPdfKey,
  pendingPitchPdfKey,
  isPendingPitchKey,
  finalizePitchHtml,
} from "../src/lib/pdf-key";

describe("pitchPdfKey", () => {
  it("builds a stable, prefixed, sortable key", () => {
    expect(pitchPdfKey("abc-123", 1717599600000)).toBe(
      "pitches/abc-123/1717599600000.pdf",
    );
  });

  it("slug-sanitizes the deal id so it can't escape the prefix", () => {
    // A hostile/unexpected id with a slash must not create a nested path.
    expect(pitchPdfKey("../../etc/passwd", 1)).toBe("pitches/etc-passwd/1.pdf");
    expect(pitchPdfKey("Deal With Spaces", 1)).toBe("pitches/deal-with-spaces/1.pdf");
  });

  it("falls back to 'unknown' for an empty id", () => {
    expect(pitchPdfKey("", 5)).toBe("pitches/unknown/5.pdf");
  });

  it("truncates non-integer timestamps", () => {
    expect(pitchPdfKey("d1", 1717599600000.9)).toBe("pitches/d1/1717599600000.pdf");
  });
});

describe("pendingPitchPdfKey", () => {
  it("marks the fallback key with a pending- prefix on the filename", () => {
    expect(pendingPitchPdfKey("abc-123", 42)).toBe("pitches/abc-123/pending-42.pdf");
  });
});

describe("isPendingPitchKey", () => {
  it("distinguishes pending from real keys", () => {
    expect(isPendingPitchKey(pendingPitchPdfKey("d", 1))).toBe(true);
    expect(isPendingPitchKey(pitchPdfKey("d", 1))).toBe(false);
  });
});

describe("finalizePitchHtml", () => {
  it("passes through a full document untouched", () => {
    const doc = "<!DOCTYPE html><html><body>hi</body></html>";
    expect(finalizePitchHtml(doc)).toBe(doc);
  });

  it("passes through documents that start with <html>", () => {
    const doc = '<html lang="en"><body>x</body></html>';
    expect(finalizePitchHtml(doc)).toBe(doc);
  });

  it("wraps a bare fragment in a minimal HTML5 shell", () => {
    const out = finalizePitchHtml("<section>deck</section>");
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<section>deck</section>");
    expect(out).toContain("<body>");
  });

  it("tolerates empty / nullish input", () => {
    expect(finalizePitchHtml("")).toContain("<!DOCTYPE html>");
    // @ts-expect-error — guarding runtime nullish even though typed string
    expect(finalizePitchHtml(undefined)).toContain("<!DOCTYPE html>");
  });
});

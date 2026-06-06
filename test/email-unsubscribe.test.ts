import { describe, it, expect } from "vitest";
import { extractUnsubscribe } from "../src/roles/email/unsubscribe";

describe("extractUnsubscribe — RFC 8058 one-click POST", () => {
  it("sets oneClick when List-Unsubscribe-Post: One-Click + https URL are present", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<https://example.com/u?id=42>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(r).not.toBeNull();
    expect(r!.oneClick).toEqual({ url: "https://example.com/u?id=42" });
    expect(r!.url).toBe("https://example.com/u?id=42");
    expect(r!.raw).toBe("<https://example.com/u?id=42>");
  });

  it("does NOT set oneClick when the Post header is absent (plain URL only)", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<https://example.com/u?id=42>",
    });
    expect(r).not.toBeNull();
    expect(r!.oneClick).toBeUndefined();
    expect(r!.url).toBe("https://example.com/u?id=42");
  });

  it("does NOT set oneClick when only a mailto is present, even with the Post header", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<mailto:unsub@example.com>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(r).not.toBeNull();
    expect(r!.oneClick).toBeUndefined();
    expect(r!.mailto).toEqual({ address: "unsub@example.com" });
  });

  it("tolerates whitespace / case variance in the Post header value", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<https://e.com/u>",
      "List-Unsubscribe-Post": "List-Unsubscribe = one-click",
    });
    expect(r!.oneClick).toEqual({ url: "https://e.com/u" });
  });
});

describe("extractUnsubscribe — mailto parsing", () => {
  it("parses a mailto-only option without a subject", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<mailto:unsubscribe@list.example.com>",
    });
    expect(r).not.toBeNull();
    expect(r!.mailto).toEqual({ address: "unsubscribe@list.example.com" });
    expect(r!.url).toBeUndefined();
    expect(r!.oneClick).toBeUndefined();
  });

  it("parses the subject query param (percent-decoded)", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<mailto:unsub@x.com?subject=unsubscribe%20me>",
    });
    expect(r!.mailto).toEqual({ address: "unsub@x.com", subject: "unsubscribe me" });
  });

  it("decodes + as a space in the subject and ignores other params", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<mailto:unsub@x.com?body=hi&subject=remove+me>",
    });
    expect(r!.mailto).toEqual({ address: "unsub@x.com", subject: "remove me" });
  });

  it("a comma inside the mailto query does not split the item", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<mailto:unsub@x.com?subject=a,b,c>",
    });
    expect(r!.mailto).toEqual({ address: "unsub@x.com", subject: "a,b,c" });
  });
});

describe("extractUnsubscribe — both options present", () => {
  it("parses https + mailto from a comma-separated list", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe":
        "<https://example.com/unsub?u=1>, <mailto:unsub@example.com?subject=unsubscribe>",
    });
    expect(r).not.toBeNull();
    expect(r!.url).toBe("https://example.com/unsub?u=1");
    expect(r!.mailto).toEqual({ address: "unsub@example.com", subject: "unsubscribe" });
    expect(r!.oneClick).toBeUndefined();
  });

  it("sets oneClick AND keeps mailto when both options + Post header are present", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe":
        "<mailto:u@x.com?subject=unsub>, <https://x.com/oneclick?t=9>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(r!.oneClick).toEqual({ url: "https://x.com/oneclick?t=9" });
    expect(r!.url).toBe("https://x.com/oneclick?t=9");
    expect(r!.mailto).toEqual({ address: "u@x.com", subject: "unsub" });
  });
});

describe("extractUnsubscribe — plain URL only", () => {
  it("returns url with no mailto and no oneClick", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "<https://news.example.com/opt-out/abc123>",
    });
    expect(r).toEqual({
      raw: "<https://news.example.com/opt-out/abc123>",
      url: "https://news.example.com/opt-out/abc123",
    });
  });
});

describe("extractUnsubscribe — malformed / empty → null", () => {
  it("returns null when there is no List-Unsubscribe header", () => {
    expect(extractUnsubscribe({ From: "a@b.com", Subject: "hi" })).toBeNull();
  });

  it("returns null for an empty header value", () => {
    expect(extractUnsubscribe({ "List-Unsubscribe": "" })).toBeNull();
    expect(extractUnsubscribe({ "List-Unsubscribe": "   " })).toBeNull();
  });

  it("returns null when no angle-bracketed URIs are present", () => {
    expect(extractUnsubscribe({ "List-Unsubscribe": "not a uri" })).toBeNull();
  });

  it("returns null when only unsupported schemes are listed (http, ftp)", () => {
    expect(
      extractUnsubscribe({ "List-Unsubscribe": "<http://insecure.example.com/u>" }),
    ).toBeNull();
    expect(
      extractUnsubscribe({ "List-Unsubscribe": "<ftp://x.example.com/u>" }),
    ).toBeNull();
  });

  it("returns null for an empty header map", () => {
    expect(extractUnsubscribe({})).toBeNull();
  });
});

describe("extractUnsubscribe — angle-bracket stripping", () => {
  it("strips the angle brackets from extracted URIs", () => {
    const r = extractUnsubscribe({ "List-Unsubscribe": "<https://x.com/u>" });
    expect(r!.url).toBe("https://x.com/u");
    expect(r!.url).not.toContain("<");
    expect(r!.url).not.toContain(">");
  });

  it("tolerates whitespace inside and between brackets", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe": "  < https://x.com/u >  ,  < mailto:u@x.com >  ",
    });
    expect(r!.url).toBe("https://x.com/u");
    expect(r!.mailto).toEqual({ address: "u@x.com" });
  });
});

describe("extractUnsubscribe — case-insensitive header lookup", () => {
  it("finds a lower-cased List-Unsubscribe header", () => {
    const r = extractUnsubscribe({ "list-unsubscribe": "<https://x.com/u>" });
    expect(r!.url).toBe("https://x.com/u");
  });

  it("finds an upper-cased Post header for one-click", () => {
    const r = extractUnsubscribe({
      "LIST-UNSUBSCRIBE": "<https://x.com/u>",
      "LIST-UNSUBSCRIBE-POST": "List-Unsubscribe=One-Click",
    });
    expect(r!.oneClick).toEqual({ url: "https://x.com/u" });
  });
});

describe("extractUnsubscribe — multiple URLs", () => {
  it("picks the first https URL as the plain-URL / one-click option", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe":
        "<https://first.example.com/u>, <https://second.example.com/u>",
    });
    expect(r!.url).toBe("https://first.example.com/u");
  });

  it("first https URL is used for one-click when Post header present", () => {
    const r = extractUnsubscribe({
      "List-Unsubscribe":
        "<https://a.example.com/u>, <https://b.example.com/u>, <mailto:u@x.com>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(r!.oneClick).toEqual({ url: "https://a.example.com/u" });
    expect(r!.url).toBe("https://a.example.com/u");
    expect(r!.mailto).toEqual({ address: "u@x.com" });
  });
});

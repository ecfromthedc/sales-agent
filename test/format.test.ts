import { describe, it, expect } from "vitest";
import { truncate, slugify } from "../src/lib/format";

describe("truncate", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });
  it("cuts long strings with an ellipsis", () => {
    expect(truncate("hello world", 5)).toBe("hell…");
  });
  it("handles non-positive max", () => {
    expect(truncate("abc", 0)).toBe("");
  });
});

describe("slugify", () => {
  it("makes a branch-safe slug", () => {
    expect(slugify("Wire CF Browser Rendering!")).toBe("wire-cf-browser-rendering");
  });
  it("trims leading/trailing dashes", () => {
    expect(slugify("  --Hello-- ")).toBe("hello");
  });
});

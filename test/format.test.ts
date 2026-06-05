import { describe, it, expect } from "vitest";
import { truncate, slugify, formatUSD, clamp, compact } from "../src/lib/format";

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

describe("formatUSD", () => {
  it("formats whole dollars with separators", () => {
    expect(formatUSD(1500)).toBe("$1,500");
  });
  it("rounds and guards NaN", () => {
    expect(formatUSD(1499.6)).toBe("$1,500");
    expect(formatUSD(NaN)).toBe("$0");
  });
});

describe("clamp", () => {
  it("bounds values", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("compact", () => {
  it("compacts thousands and millions", () => {
    expect(compact(12500)).toBe("12.5K");
    expect(compact(2_400_000)).toBe("2.4M");
    expect(compact(900)).toBe("900");
  });
});

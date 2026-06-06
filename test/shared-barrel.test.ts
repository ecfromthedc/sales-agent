import { describe, expect, it } from "vitest";

// SALE-109: the src/shared barrel is the cross-role primitive surface for the
// monorepo (sales / outreach / email / proposals). This test locks its contract:
// the barrel must re-export the expected core primitives, and each must resolve
// to a defined function — proving the re-export wiring is intact and that a
// downstream role can `import { ... } from "../shared"` to reach them.
import * as shared from "../src/shared";

describe("src/shared barrel", () => {
  const expected = [
    "apiFetch",
    "HttpError",
    "callClaude",
    "getGoogleAccessToken",
    "notionFetch",
    "getSpotifyToken",
  ] as const;

  it.each(expected)("re-exports %s as a defined function", (name) => {
    const value = (shared as Record<string, unknown>)[name];
    expect(value).toBeDefined();
    expect(typeof value).toBe("function");
  });

  it("re-exports exactly the expected primitive surface", () => {
    expect(Object.keys(shared).sort()).toEqual([...expected].sort());
  });
});

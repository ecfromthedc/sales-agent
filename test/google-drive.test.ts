import { describe, it, expect } from "vitest";
import { parseMeetingStartFromName } from "../src/integrations/google-drive";

// The transcript-poll cron resolves each Drive transcript back to its Notion
// deal partly by meeting start time. That timestamp is parsed best-effort out
// of the Drive filename, which Google formats inconsistently across plans.
// These cases lock the parser's behavior so a regex tweak can't silently break
// deal resolution.
describe("parseMeetingStartFromName", () => {
  it("parses the newer Google Docs naming pattern (slashed date)", () => {
    const iso = parseMeetingStartFromName(
      "Rising Tides Strategy Session - 2026/05/14 11:30 EDT - Transcript",
    );
    // -04:00 offset assumed (America/New_York); 11:30 local → 15:30 UTC
    expect(iso).toBe("2026-05-14T15:30:00.000Z");
  });

  it("parses the older Transcript naming pattern (dashed date)", () => {
    const iso = parseMeetingStartFromName(
      "Rising Tides Strategy Session - Transcript 2026-05-14 11:30 EDT",
    );
    expect(iso).toBe("2026-05-14T15:30:00.000Z");
  });

  it("zero-pads a single-digit hour", () => {
    const iso = parseMeetingStartFromName("Quick Sync - 2026/05/14 9:05 EDT - Transcript");
    expect(iso).toBe("2026-05-14T13:05:00.000Z");
  });

  it("returns undefined when no date/time is present", () => {
    expect(parseMeetingStartFromName("Meeting Notes by Gemini")).toBeUndefined();
    expect(parseMeetingStartFromName("Transcript")).toBeUndefined();
  });

  it("returns undefined for a malformed/partial timestamp", () => {
    // Date present but no time → no match.
    expect(parseMeetingStartFromName("Strategy Session 2026/05/14 - Transcript")).toBeUndefined();
  });
});

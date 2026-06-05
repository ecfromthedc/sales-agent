import { describe, it, expect } from "vitest";
import {
  PITCH_SECTIONS,
  PITCH_SECTION_IDS,
  type PitchSectionId,
  isPitchSectionId,
  sectionsPromptBlock,
  orderSections,
  missingSections,
} from "../src/lib/pitch-sections";

const ALL_IDS: PitchSectionId[] = [
  "cover",
  "opportunity",
  "whatWeHeard",
  "proposedCampaign",
  "creatorsReach",
  "timeline",
  "investment",
  "nextSteps",
];

describe("PITCH_SECTIONS template", () => {
  it("is non-empty and defines a stable canonical order", () => {
    expect(PITCH_SECTION_IDS).toEqual(ALL_IDS);
  });
  it("has unique ids", () => {
    expect(new Set(PITCH_SECTION_IDS).size).toBe(PITCH_SECTION_IDS.length);
  });
  it("every section has a title and a prompt", () => {
    for (const s of PITCH_SECTIONS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.prompt.trim().length).toBeGreaterThan(0);
    }
  });
  it("opens on cover and closes on next steps", () => {
    expect(PITCH_SECTION_IDS[0]).toBe("cover");
    expect(PITCH_SECTION_IDS[PITCH_SECTION_IDS.length - 1]).toBe("nextSteps");
  });
});

describe("isPitchSectionId", () => {
  it("accepts canonical ids", () => {
    expect(isPitchSectionId("cover")).toBe(true);
    expect(isPitchSectionId("nextSteps")).toBe(true);
  });
  it("rejects unknown and non-string values", () => {
    expect(isPitchSectionId("intro")).toBe(false);
    expect(isPitchSectionId(7)).toBe(false);
    expect(isPitchSectionId(undefined)).toBe(false);
    expect(isPitchSectionId(null)).toBe(false);
  });
});

describe("sectionsPromptBlock", () => {
  it("lists every section, numbered and in order", () => {
    const block = sectionsPromptBlock();
    const lines = block.split("\n");
    expect(lines).toHaveLength(PITCH_SECTIONS.length);
    expect(lines[0].startsWith("1. ")).toBe(true);
    for (const id of PITCH_SECTION_IDS) {
      expect(block).toContain(`"${id}"`);
    }
  });
});

describe("orderSections", () => {
  it("returns the full canonical set in order even from empty input", () => {
    const out = orderSections(undefined);
    expect(out.map((s) => s.id)).toEqual(ALL_IDS);
    expect(out.every((s) => s.body === "")).toBe(true);
  });

  it("reorders shuffled model output into canonical order", () => {
    const raw = [
      { id: "nextSteps", body: "book the kickoff" },
      { id: "cover", body: "Artist X — TikTok seeding" },
      { id: "opportunity", body: "70M listeners, no creator play yet" },
    ];
    const out = orderSections(raw);
    expect(out.map((s) => s.id)).toEqual(ALL_IDS);
    expect(out[0]).toMatchObject({ id: "cover", body: "Artist X — TikTok seeding" });
    expect(out[1]).toMatchObject({ id: "opportunity" });
    expect(out[out.length - 1]).toMatchObject({ id: "nextSteps", body: "book the kickoff" });
  });

  it("fills missing sections with empty bodies", () => {
    const out = orderSections([{ id: "cover", body: "Cover copy" }]);
    expect(out.map((s) => s.id)).toEqual(ALL_IDS);
    const cover = out.find((s) => s.id === "cover");
    expect(cover?.body).toBe("Cover copy");
    expect(out.filter((s) => s.body === "")).toHaveLength(ALL_IDS.length - 1);
  });

  it("drops unknown ids and trims bodies", () => {
    const raw = [
      { id: "intro", body: "not a real section" },
      { id: "timeline", body: "  4-week phased rollout  " },
    ];
    const out = orderSections(raw);
    expect(out.map((s) => s.id)).toEqual(ALL_IDS);
    expect(out.find((s) => s.id === "timeline")?.body).toBe("4-week phased rollout");
  });

  it("keeps the first occurrence when an id is duplicated", () => {
    const raw = [
      { id: "cover", body: "first" },
      { id: "cover", body: "second" },
    ];
    expect(orderSections(raw).find((s) => s.id === "cover")?.body).toBe("first");
  });

  it("tolerates malformed entries without throwing", () => {
    const raw = [null, 42, "nope", {}, { id: "cover" }, { id: "opportunity", body: 99 }];
    const out = orderSections(raw);
    expect(out.map((s) => s.id)).toEqual(ALL_IDS);
    expect(out.find((s) => s.id === "cover")?.body).toBe("");
    expect(out.find((s) => s.id === "opportunity")?.body).toBe("");
  });

  it("returns the full set for non-array input", () => {
    expect(orderSections({ id: "cover", body: "x" }).map((s) => s.id)).toEqual(ALL_IDS);
  });
});

describe("missingSections", () => {
  it("reports nothing when all bodies are filled", () => {
    const filled = PITCH_SECTIONS.map((s) => ({ id: s.id, title: s.title, body: "x" }));
    expect(missingSections(filled)).toEqual([]);
  });
  it("reports empty / whitespace-only sections in canonical order", () => {
    const out = orderSections([
      { id: "cover", body: "c" },
      { id: "timeline", body: "   " },
    ]);
    expect(missingSections(out)).toEqual(
      ALL_IDS.filter((id) => id !== "cover"),
    );
  });
});

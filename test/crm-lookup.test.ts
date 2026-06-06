import { describe, it, expect } from "vitest";
import { mapPageToCampaignMatch, type NotionPage } from "../src/roles/sales/integrations/crm-lookup";

describe("mapPageToCampaignMatch", () => {
  it("maps a fully-populated Notion page", () => {
    const page: NotionPage = {
      id: "1961465b-b829-80c9-a1b5-c4cb3284149a",
      properties: {
        "Artist Name": { title: [{ text: { content: "SZA" } }] },
        "Song Name": { rich_text: [{ text: { content: "Snooze" } }] },
        "Campaign Stage": { status: { name: "Live" } },
        "Pipeline Status": { status: { name: "Active" } },
        "Media Spend": { number: 25000 },
        "Label/Distro Partner": { rich_text: [{ text: { content: "TDE" } }] },
        "Desired Start Date": { date: { start: "2026-01-15" } },
        "Future potencial": { select: { name: "High" } },
        "Types of Content Creators": {
          multi_select: [{ name: "Dancers" }, { name: "Lifestyle" }],
        },
      },
    };

    expect(mapPageToCampaignMatch(page)).toEqual({
      artistName: "SZA",
      songName: "Snooze",
      campaignStage: "Live",
      pipelineStatus: "Active",
      mediaSpend: 25000,
      labelPartner: "TDE",
      startDate: "2026-01-15",
      futurePotential: "High",
      creatorTypes: ["Dancers", "Lifestyle"],
      notionUrl: "https://www.notion.so/1961465bb82980c9a1b5c4cb3284149a",
    });
  });

  it("defaults every field when Notion omits empty properties", () => {
    const page: NotionPage = { id: "abc-def", properties: {} };
    const m = mapPageToCampaignMatch(page);

    expect(m.artistName).toBe("Unknown");
    expect(m.songName).toBe("");
    expect(m.campaignStage).toBe("Unknown");
    expect(m.pipelineStatus).toBe("Unknown");
    expect(m.mediaSpend).toBeNull();
    expect(m.labelPartner).toBe("");
    expect(m.startDate).toBeNull();
    expect(m.futurePotential).toBe("");
    expect(m.creatorTypes).toEqual([]);
    // hyphens stripped from page id
    expect(m.notionUrl).toBe("https://www.notion.so/abcdef");
  });

  it("treats a zero media spend as a real value, not a default", () => {
    const page: NotionPage = {
      id: "x",
      properties: { "Media Spend": { number: 0 } },
    };
    expect(mapPageToCampaignMatch(page).mediaSpend).toBe(0);
  });
});

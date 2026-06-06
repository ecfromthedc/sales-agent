/**
 * CRM Lookup — searches the Rising Tides CRM (Notion) for past campaigns
 * involving the prospect's artist name, label, or related artists.
 *
 * This replaces the broken Tides Tracker stub. The CRM is the source of truth
 * for campaign history — not Gmail, not a separate API.
 *
 * Database: Rising Tides CRM (1961465b-b829-8009-9536-000bdd0226f1)
 */

import type { Env } from "../../../lib/env";
import type { ComparableCandidate } from "../../../lib/comparables";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const CRM_DB_ID = "1961465b-b829-80c9-a1b5-c4cb3284149a";

export interface CampaignMatch {
  artistName: string;
  songName: string;
  campaignStage: string;
  pipelineStatus: string;
  mediaSpend: number | null;
  labelPartner: string;
  startDate: string | null;
  futurePotential: string;
  creatorTypes: string[];
  notionUrl: string;
}

export interface CRMLookupResult {
  exactMatches: CampaignMatch[];
  labelMatches: CampaignMatch[];
  totalCampaignsFound: number;
}

export async function lookupCRM(
  query: {
    artistName: string;
    label?: string;
    relatedArtists?: string[];
  },
  env: Env,
): Promise<CRMLookupResult> {
  const result: CRMLookupResult = {
    exactMatches: [],
    labelMatches: [],
    totalCampaignsFound: 0,
  };

  try {
    // Search 1: Artist name (fuzzy — "contains" match catches "Isaiah Rashad & SZA" when searching "SZA")
    const artistResults = await searchCRM(
      { property: "Artist Name", title: { contains: query.artistName } },
      env,
    );
    result.exactMatches = artistResults;

    // Search 2: If we have related artists from Songstats, search for those too
    // This surfaces campaigns for artists in the same lane
    if (query.relatedArtists && query.relatedArtists.length > 0) {
      // Search for top 3 related artists to stay within rate limits
      for (const related of query.relatedArtists.slice(0, 3)) {
        const relatedResults = await searchCRM(
          { property: "Artist Name", title: { contains: related } },
          env,
        );
        // Don't add duplicates
        for (const r of relatedResults) {
          if (!result.exactMatches.some((e) => e.notionUrl === r.notionUrl)) {
            result.labelMatches.push(r);
          }
        }
      }
    }

    // Search 3: Label match (if prospect has a known label)
    if (query.label) {
      const labelResults = await searchCRM(
        { property: "Label/Distro Partner", rich_text: { contains: query.label } },
        env,
      );
      for (const r of labelResults) {
        if (
          !result.exactMatches.some((e) => e.notionUrl === r.notionUrl) &&
          !result.labelMatches.some((e) => e.notionUrl === r.notionUrl)
        ) {
          result.labelMatches.push(r);
        }
      }
    }

    result.totalCampaignsFound = result.exactMatches.length + result.labelMatches.length;
  } catch (err) {
    console.warn("crm_lookup_failed", (err as Error).message);
  }

  return result;
}

/**
 * Adapt a CRM `CampaignMatch` into a `ComparableCandidate` for the comparables
 * ranker.
 *
 * The CRM row does not currently carry the past client's genre tags or audience
 * size, so those fields are left `undefined` — we do NOT invent them. The
 * ranker therefore scores CRM-derived candidates on recency (campaign
 * `startDate`) and, when future schema work adds genre/audience columns, this
 * adapter is the single place to wire them in. Same-lane relevance is already
 * guaranteed upstream: candidates only reach here because the artist, label, or
 * a related artist matched.
 */
export function campaignToComparable(match: CampaignMatch): ComparableCandidate {
  return {
    id: match.notionUrl,
    artistName: match.artistName,
    startDate: match.startDate,
    // genres / audience intentionally omitted — not present on CRM rows.
  };
}

async function searchCRM(
  filter: Record<string, unknown>,
  env: Env,
): Promise<CampaignMatch[]> {
  const res = await fetch(`${NOTION_API}/databases/${CRM_DB_ID}/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.NOTION_API_KEY}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ filter, page_size: 10 }),
  });

  if (!res.ok) return [];

  const data = (await res.json()) as {
    results: NotionPage[];
  };

  return data.results.map(mapPageToCampaignMatch);
}

/** A Notion query result row, narrowed to what we read. */
export interface NotionPage {
  id: string;
  properties: Record<string, any>;
}

/**
 * Shape a raw Notion CRM page into a `CampaignMatch`.
 *
 * Pure — no I/O. Extracted so the (brittle) Notion property unwrapping is
 * unit-testable independent of the network. Every field is defensively
 * defaulted because Notion omits empty properties' inner arrays.
 */
export function mapPageToCampaignMatch(page: NotionPage): CampaignMatch {
  const p = page.properties;
  return {
    artistName: p["Artist Name"]?.title?.[0]?.text?.content ?? "Unknown",
    songName: p["Song Name"]?.rich_text?.[0]?.text?.content ?? "",
    campaignStage: p["Campaign Stage"]?.status?.name ?? "Unknown",
    pipelineStatus: p["Pipeline Status"]?.status?.name ?? "Unknown",
    mediaSpend: p["Media Spend"]?.number ?? null,
    labelPartner: p["Label/Distro Partner"]?.rich_text?.[0]?.text?.content ?? "",
    startDate: p["Desired Start Date"]?.date?.start ?? null,
    futurePotential: p["Future potencial"]?.select?.name ?? "",
    creatorTypes: (p["Types of Content Creators"]?.multi_select ?? []).map(
      (s: any) => s.name,
    ),
    notionUrl: `https://www.notion.so/${page.id.replace(/-/g, "")}`,
  };
}

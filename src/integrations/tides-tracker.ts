/**
 * Tides Tracker lookup — "has this artist / label / manager run campaigns with RT before?"
 *
 * Endpoint is internal; replace TIDES_TRACKER_BASE_URL below with the real host.
 * Stub for now — wire to the real API once exposed.
 */

import type { Env } from "../lib/env";

const TIDES_TRACKER_BASE_URL = "https://tides-tracker.risingtidesent.com/api"; // TODO confirm

export interface PastCampaignsResult {
  count: number;
  totalSpend?: number;
  campaigns: Array<{
    id: string;
    name: string;
    artist?: string;
    label?: string;
    startedAt: string;
    impressions?: number;
    performance?: "strong" | "neutral" | "weak";
  }>;
}

export async function lookupPastCampaigns(
  query: { email: string; name: string },
  env: Env,
): Promise<PastCampaignsResult> {
  try {
    const res = await fetch(`${TIDES_TRACKER_BASE_URL}/lookup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TIDES_TRACKER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(query),
    });
    if (!res.ok) {
      return { count: 0, campaigns: [] };
    }
    return (await res.json()) as PastCampaignsResult;
  } catch {
    return { count: 0, campaigns: [] };
  }
}

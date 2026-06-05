/**
 * Tides Tracker lookup — "has this artist / label / manager run campaigns with RT before?"
 *
 * @deprecated Superseded by `crm-lookup.ts`. The Rising Tides CRM (Notion) is the
 * canonical source of truth for campaign history; all callers (e.g.
 * `agents/pre-call-brief.ts`) use `lookupCRM` instead. This module is retained
 * only in case the standalone Tides Tracker service is ever exposed and wired
 * back in. It has no importers today.
 *
 * Base URL was never confirmed (the old hardcoded host was a guess), so it is
 * now env-driven via `TIDES_TRACKER_BASE_URL`. When that var is absent the
 * function is a guarded no-op and returns an empty result rather than hitting
 * an unverified endpoint.
 */

import type { Env } from "../lib/env";

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

const EMPTY: PastCampaignsResult = { count: 0, campaigns: [] };

/**
 * @deprecated Prefer `lookupCRM` from `crm-lookup.ts`. No-ops unless both
 * `TIDES_TRACKER_BASE_URL` and `TIDES_TRACKER_API_KEY` are configured.
 */
export async function lookupPastCampaigns(
  query: { email: string; name: string },
  env: Env & { TIDES_TRACKER_BASE_URL?: string },
): Promise<PastCampaignsResult> {
  const baseUrl = env.TIDES_TRACKER_BASE_URL?.replace(/\/+$/, "");
  if (!baseUrl || !env.TIDES_TRACKER_API_KEY) {
    // Unconfigured: do not call an unverified host. CRM lookup is the source of truth.
    return EMPTY;
  }

  try {
    const res = await fetch(`${baseUrl}/lookup`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.TIDES_TRACKER_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(query),
    });
    if (!res.ok) {
      return EMPTY;
    }
    return (await res.json()) as PastCampaignsResult;
  } catch {
    return EMPTY;
  }
}

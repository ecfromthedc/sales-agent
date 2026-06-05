/**
 * Chartmetric enrichment.
 *
 * Adds the cross-platform popularity signal that Spotify/Songstats don't give:
 *   - cm_artist_score  (0–100 composite "how hot is this artist right now")
 *   - cm_artist_rank   (global artist rank)
 *   - genres + country
 *
 * Auth: a long-lived refresh token (CHARTMETRIC_REFRESH_TOKEN secret) is
 * exchanged for a 1-hour access token. That access token is cached in KV so we
 * authenticate at most once per ~55 min instead of on every lookup.
 *
 * COST DISCIPLINE — Chartmetric's rate limit is ~25 requests per window, so:
 *   - access token cached in KV (1 auth / 55 min)
 *   - full enrichment result cached per artist for 24h
 *   - max 2 API calls per cache-miss (id mapping + artist object)
 *   - event-driven only (pre-call brief on booking, never on the cron tick)
 *   - a 429 returns null immediately — never retry-loops into the limit
 */

import type { Env } from "../lib/env";

const CHARTMETRIC_BASE = "https://api.chartmetric.com/api";
const TOKEN_CACHE_KEY = "chartmetric:token";
const TOKEN_TTL = 3300; // 55 min — access token lives 3600s, refresh early
const RESULT_TTL = 86400; // 24h

// Hard runaway ceiling: a circuit breaker independent of the per-artist cache.
// Even if something loops, we never make more than this many Chartmetric calls
// per UTC day. Bookings are low-volume + cached, so a real day is single digits;
// this only ever trips on a bug. Bump DAILY_CALL_CEILING if volume ever grows.
const DAILY_CALL_CEILING = 200;

async function withinDailyBudget(env: Env): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const key = `chartmetric:calls:${day}`;
  const used = parseInt((await env.STATE.get(key)) ?? "0", 10) || 0;
  if (used >= DAILY_CALL_CEILING) {
    console.warn("chartmetric_daily_ceiling_hit", { day, used, ceiling: DAILY_CALL_CEILING });
    return false;
  }
  // +2 reflects the max calls a single cache-miss makes (id mapping + artist obj).
  await env.STATE.put(key, String(used + 2), { expirationTtl: 172800 }).catch(() => {});
  return true;
}

export interface ChartmetricEnrichment {
  name: string;
  chartmetricId: number;
  cmScore: number | null; // 0–100 composite popularity
  cmRank: number | null; // global artist rank
  genrePrimary: string | null;
  genresSecondary: string[];
  country: string | null;
  spotifyMonthlyListeners: number | null; // only populated on the name-search path
  spotifyFollowers: number | null;
  chartmetricUrl: string | null;
}

/**
 * Exchange the refresh token for an access token, cached in KV.
 * Returns null if the secret is missing or the exchange fails.
 */
async function getAccessToken(env: Env): Promise<string | null> {
  if (!env.CHARTMETRIC_REFRESH_TOKEN) {
    console.warn("chartmetric_skip: CHARTMETRIC_REFRESH_TOKEN not set");
    return null;
  }

  const cached = await env.STATE.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  try {
    const res = await fetch(`${CHARTMETRIC_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshtoken: env.CHARTMETRIC_REFRESH_TOKEN }),
    });
    if (!res.ok) {
      console.warn("chartmetric_token_failed", { status: res.status });
      return null;
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) return null;

    await env.STATE.put(TOKEN_CACHE_KEY, data.token, { expirationTtl: TOKEN_TTL }).catch(() => {});
    return data.token;
  } catch (e) {
    console.warn("chartmetric_token_error", (e as Error).message);
    return null;
  }
}

async function cmFetch(path: string, token: string): Promise<any | null> {
  const res = await fetch(`${CHARTMETRIC_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    console.warn("chartmetric_rate_limited", { path });
    return null; // bail — do not retry into the limit
  }
  if (!res.ok) {
    console.warn("chartmetric_fetch_failed", { path, status: res.status });
    return null;
  }
  return (await res.json()) as any;
}

/**
 * Enrich an artist with Chartmetric's popularity score.
 *
 * Prefers the Spotify artist ID (exact mapping). Falls back to a name search
 * when no Spotify ID is available. Returns null on any failure — enrichment is
 * best-effort and must never block the brief.
 */
export async function enrichFromChartmetric(
  params: { spotifyArtistId: string | null; artistName: string | null },
  env: Env,
): Promise<ChartmetricEnrichment | null> {
  const { spotifyArtistId, artistName } = params;
  if (!spotifyArtistId && !artistName) return null;

  const cacheKey = `chartmetric:${spotifyArtistId ?? `name:${artistName}`}`;
  const cached = (await env.STATE.get(cacheKey, "json")) as ChartmetricEnrichment | null;
  if (cached) {
    console.log("chartmetric_cache_hit", { cacheKey });
    return cached;
  }

  // Circuit breaker — bail before spending any quota if the daily ceiling is hit.
  if (!(await withinDailyBudget(env))) return null;

  const token = await getAccessToken(env);
  if (!token) return null;

  // Resolve the Chartmetric artist id (call #1) — and capture search stats if we
  // go the name route, so the fallback path still yields listeners/followers.
  let cmId: number | null = null;
  let searchListeners: number | null = null;
  let searchFollowers: number | null = null;

  if (spotifyArtistId) {
    const ids = await cmFetch(`/artist/spotify/${spotifyArtistId}/get-ids`, token);
    cmId = Array.isArray(ids?.obj) ? ids.obj[0]?.cm_artist ?? null : null;
  }

  if (!cmId && artistName) {
    const search = await cmFetch(
      `/search?q=${encodeURIComponent(artistName)}&type=artists&limit=1`,
      token,
    );
    const hit = search?.obj?.artists?.[0];
    if (hit) {
      cmId = hit.id ?? null;
      searchListeners = hit.sp_monthly_listeners ?? null;
      searchFollowers = hit.sp_followers ?? null;
    }
  }

  if (!cmId) {
    console.warn("chartmetric_no_match", { spotifyArtistId, artistName });
    return null;
  }

  // Full artist object (call #2) — the authoritative score, rank, and genres.
  const artist = await cmFetch(`/artist/${cmId}`, token);
  const obj = artist?.obj ?? {};

  const result: ChartmetricEnrichment = {
    name: obj.name ?? artistName ?? "Unknown",
    chartmetricId: cmId,
    cmScore: typeof obj.cm_artist_score === "number" ? Math.round(obj.cm_artist_score) : null,
    cmRank: obj.cm_artist_rank ?? null,
    genrePrimary: obj.genres?.primary?.name ?? null,
    genresSecondary: (obj.genres?.secondary ?? []).map((g: any) => g.name).filter(Boolean).slice(0, 5),
    country: obj.code2 ?? null,
    spotifyMonthlyListeners: obj.sp_monthly_listeners ?? searchListeners,
    spotifyFollowers: obj.sp_followers ?? searchFollowers,
    chartmetricUrl: `https://app.chartmetric.com/artist/${cmId}`,
  };

  await env.STATE.put(cacheKey, JSON.stringify(result), { expirationTtl: RESULT_TTL }).catch(() => {});
  console.log("chartmetric_cached", { cmId, cmScore: result.cmScore, cmRank: result.cmRank });

  return result;
}

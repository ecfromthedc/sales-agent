/**
 * Songstats enrichment via RapidAPI free tier (500 calls/month).
 *
 * Replaces Spotify's gutted public API as the primary source for:
 *   - Monthly listeners
 *   - Popularity score
 *   - Follower counts (Spotify + socials)
 *   - Playlist placements
 *   - Genre classification
 *
 * Looks up artists by Spotify ID — no Songstats ID mapping needed.
 */

import type { Env } from "../lib/env";

const SONGSTATS_BASE = "https://songstats.p.rapidapi.com";

export interface SongstatsEnrichment {
  name: string;
  country?: string;
  genres: string[];
  avatarUrl?: string;
  songstatsUrl?: string;
  spotify: {
    monthlyListeners: number | null;
    popularity: number | null;
    followers: number | null;
    streamsTotal: number | null;
    playlistsCurrent: number | null;
    playlistsEditorialCurrent: number | null;
    playlistReachCurrent: number | null;
    chartsCurrent: number | null;
  };
  social: {
    instagramFollowers: number | null;
    tiktokFollowers: number | null;
    youtubeSubscribers: number | null;
  };
  relatedArtists: Array<{ name: string; songstatsId: string }>;
  platformLinks: Array<{ source: string; url: string }>;
}

export async function enrichFromSongstats(
  spotifyArtistId: string,
  env: Env,
): Promise<SongstatsEnrichment | null> {
  if (!env.RAPIDAPI_KEY) {
    console.warn("songstats_skip: RAPIDAPI_KEY not set");
    return null;
  }

  const headers = {
    "X-RapidAPI-Key": env.RAPIDAPI_KEY,
    "X-RapidAPI-Host": "songstats.p.rapidapi.com",
    "Accept": "application/json",
  };

  // Two parallel calls: stats (all platforms) + info (metadata/genres/links)
  const [statsRes, infoRes] = await Promise.allSettled([
    fetchSongstats(`/artists/stats?spotify_artist_id=${spotifyArtistId}&source=spotify,tiktok,instagram,youtube`, headers),
    fetchSongstats(`/artists/info?spotify_artist_id=${spotifyArtistId}`, headers),
  ]);

  const stats = statsRes.status === "fulfilled" ? statsRes.value : null;
  const info = infoRes.status === "fulfilled" ? infoRes.value : null;

  if (!stats && !info) {
    console.warn("songstats_enrichment_failed: both calls failed", {
      statsErr: statsRes.status === "rejected" ? (statsRes.reason as Error).message : undefined,
      infoErr: infoRes.status === "rejected" ? (infoRes.reason as Error).message : undefined,
    });
    return null;
  }

  // Extract per-platform stats
  const spotifyStats = findSource(stats?.stats, "spotify");
  const tiktokStats = findSource(stats?.stats, "tiktok");
  const igStats = findSource(stats?.stats, "instagram");
  const ytStats = findSource(stats?.stats, "youtube");

  const artistInfo = info?.artist_info ?? stats?.artist_info ?? {};

  return {
    name: artistInfo.name ?? "Unknown",
    country: artistInfo.country ?? undefined,
    genres: artistInfo.genres ?? [],
    avatarUrl: artistInfo.avatar ?? undefined,
    songstatsUrl: artistInfo.site_url ?? undefined,
    spotify: {
      monthlyListeners: spotifyStats?.monthly_listeners_current ?? null,
      popularity: spotifyStats?.popularity_current ?? null,
      followers: spotifyStats?.followers_total ?? null,
      streamsTotal: spotifyStats?.streams_total ?? null,
      playlistsCurrent: spotifyStats?.playlists_current ?? null,
      playlistsEditorialCurrent: spotifyStats?.playlists_editorial_current ?? null,
      playlistReachCurrent: spotifyStats?.playlist_reach_current ?? null,
      chartsCurrent: spotifyStats?.charts_current ?? null,
    },
    social: {
      instagramFollowers: igStats?.followers_total ?? null,
      tiktokFollowers: tiktokStats?.followers_total ?? null,
      youtubeSubscribers: ytStats?.subscribers_total ?? null,
    },
    relatedArtists: (artistInfo.related_artists ?? []).slice(0, 8).map((a: any) => ({
      name: a.name,
      songstatsId: a.songstats_artist_id,
    })),
    platformLinks: (artistInfo.links ?? []).map((l: any) => ({
      source: l.source,
      url: l.url,
    })),
  };
}

function findSource(stats: any[] | undefined, source: string): any | null {
  if (!Array.isArray(stats)) return null;
  return stats.find((s: any) => s.source === source)?.data ?? null;
}

async function fetchSongstats(path: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(`${SONGSTATS_BASE}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`songstats_${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json() as { result: string; message: string; [key: string]: unknown };
  if (data.result !== "success") {
    throw new Error(`songstats_error: ${data.message}`);
  }
  return data;
}

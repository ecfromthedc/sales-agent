/**
 * Spotify enrichment via Client Credentials flow.
 * Takes a Spotify artist link and returns structured data for the pre-call brief.
 *
 * Calendly required field: "Artist's Spotify Profile Link?"
 * Expected format: https://open.spotify.com/artist/{id}[?...]
 */

import type { Env } from "../lib/env";

export interface SpotifyEnrichment {
  artistId: string;
  name: string;
  followers: number;
  popularity: number;          // 0-100
  genres: string[];
  topTracks: Array<{ name: string; popularity: number; playedAt?: string }>;
  recentReleases: Array<{ name: string; releaseDate: string; type: string }>;
  relatedArtists: string[];
}

export async function enrichFromSpotify(
  url: string,
  env: Env,
): Promise<SpotifyEnrichment | null> {
  const artistId = extractArtistId(url);
  if (!artistId) return null;

  const token = await getAccessToken(env);
  if (!token) return null;

  const [artist, topTracks, albums, related] = await Promise.all([
    fetchJson(`https://api.spotify.com/v1/artists/${artistId}`, token),
    fetchJson(`https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=US`, token),
    fetchJson(`https://api.spotify.com/v1/artists/${artistId}/albums?limit=10&include_groups=single,album`, token),
    fetchJson(`https://api.spotify.com/v1/artists/${artistId}/related-artists`, token),
  ]);

  return {
    artistId,
    name: artist?.name ?? "Unknown",
    followers: artist?.followers?.total ?? 0,
    popularity: artist?.popularity ?? 0,
    genres: artist?.genres ?? [],
    topTracks: (topTracks?.tracks ?? []).slice(0, 5).map((t: any) => ({
      name: t.name,
      popularity: t.popularity,
    })),
    recentReleases: (albums?.items ?? []).slice(0, 5).map((a: any) => ({
      name: a.name,
      releaseDate: a.release_date,
      type: a.album_type,
    })),
    relatedArtists: (related?.artists ?? []).slice(0, 8).map((a: any) => a.name),
  };
}

function extractArtistId(url: string): string | null {
  const m = url.match(/artist\/([a-zA-Z0-9]{22})/);
  return m?.[1] ?? null;
}

async function getAccessToken(env: Env): Promise<string | null> {
  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${creds}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) return null;
  const j = (await res.json()) as { access_token: string };
  return j.access_token;
}

async function fetchJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

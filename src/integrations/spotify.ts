/**
 * Spotify enrichment via Client Credentials flow.
 * Takes a Spotify artist link and returns structured data for the pre-call brief.
 *
 * Calendly required field: "Artist's Spotify Profile Link?"
 * Expected format: https://open.spotify.com/artist/{id}[?...]
 */

import { apiFetch } from "../lib/http";

/**
 * Minimal structural env for the Spotify client-credentials flow. Narrowed from
 * the concrete sales `Env` (SALE-129) so shared primitives don't transitively
 * pull in the full Worker env. The sales `Env` is a structural superset, so
 * every existing caller still satisfies this.
 */
export interface SpotifyEnv {
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
}

/** Spotify client-credentials token endpoint. */
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Refresh slightly early so an in-flight request never races token expiry. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * In-memory cache for the client-credentials access token.
 *
 * Worker isolates are reused across requests, so caching here avoids
 * re-exchanging credentials on every enrichment call within the token's
 * lifetime. `expiresAt` is an absolute epoch-ms deadline; once `Date.now()`
 * crosses it the next call refreshes.
 */
let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Reset the in-memory token cache. Test-only hook — not used in production code.
 * @internal
 */
export function __resetSpotifyTokenCache(): void {
  cachedToken = null;
}

/**
 * Exchange Spotify client credentials for an access token (client-credentials flow).
 *
 * Caches the token in-memory and reuses it until shortly before it expires,
 * then refreshes. Throws on a non-OK response from the token endpoint so callers
 * can decide how to handle auth/credential failures.
 */
export async function getSpotifyToken(env: SpotifyEnv): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const creds = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);
  // apiFetch parses the JSON body and throws an HttpError (carrying the status)
  // on a non-2xx response — same observable behavior as the manual fetch +
  // !res.ok throw it replaces.
  const j = await apiFetch<{ access_token: string; expires_in?: number }>(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${creds}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  // Spotify returns expires_in in seconds; default to 1h if absent.
  const ttlMs = (j.expires_in ?? 3600) * 1000;
  cachedToken = {
    value: j.access_token,
    expiresAt: Date.now() + ttlMs - TOKEN_EXPIRY_SKEW_MS,
  };
  return j.access_token;
}

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
  env: SpotifyEnv,
): Promise<SpotifyEnrichment | null> {
  const artistId = extractArtistId(url);
  if (!artistId) return null;

  let token: string;
  try {
    token = await getSpotifyToken(env);
  } catch {
    // Enrichment is best-effort and must never block the brief.
    return null;
  }

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

async function fetchJson(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

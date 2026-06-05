import type { Env } from '../lib/env';
import type { SpotifyRelease, ReleaseCadence } from '../lib/types';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getAccessToken(env: Env): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) throw new Error(`Spotify auth failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string; expires_in: number };

  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
}

async function spotifyFetch(env: Env, path: string): Promise<unknown> {
  const token = await getAccessToken(env);
  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      throw new Error(`Spotify rate limited. Retry after ${retryAfter}s`);
    }
    throw new Error(`Spotify API error: ${response.status}`);
  }

  return response.json();
}

export async function getArtistReleases(env: Env, artistId: string, limit = 20): Promise<SpotifyRelease[]> {
  const data = (await spotifyFetch(
    env,
    `/artists/${artistId}/albums?include_groups=album,single&limit=${limit}&market=US`,
  )) as {
    items: Array<{
      name: string;
      release_date: string;
      album_type: string;
      total_tracks: number;
    }>;
  };

  return data.items.map((album) => ({
    name: album.name,
    releaseDate: album.release_date,
    type: album.album_type as SpotifyRelease['type'],
    trackCount: album.total_tracks,
  }));
}

export async function getArtistMetrics(
  env: Env,
  artistId: string,
): Promise<{ monthlyListeners: number; followers: number; genres: string[] }> {
  const data = (await spotifyFetch(env, `/artists/${artistId}`)) as {
    followers: { total: number };
    genres: string[];
  };

  // Note: monthly listeners not available via public API, would need scraping
  return {
    monthlyListeners: 0, // Placeholder — enriched from other sources
    followers: data.followers.total,
    genres: data.genres,
  };
}

export async function searchArtistsByLabel(env: Env, labelName: string): Promise<
  Array<{
    id: string;
    name: string;
    followers: number;
    genres: string[];
  }>
> {
  // Spotify search with label: filter
  const query = encodeURIComponent(`label:"${labelName}"`);
  const data = (await spotifyFetch(env, `/search?q=${query}&type=artist&limit=50`)) as {
    artists: {
      items: Array<{
        id: string;
        name: string;
        followers: { total: number };
        genres: string[];
      }>;
    };
  };

  return data.artists.items.map((a) => ({
    id: a.id,
    name: a.name,
    followers: a.followers.total,
    genres: a.genres,
  }));
}

export function computeReleaseCadence(releases: SpotifyRelease[]): ReleaseCadence | null {
  if (releases.length < 2) return null;

  const dates = releases
    .map((r) => new Date(r.releaseDate).getTime())
    .sort((a, b) => b - a); // newest first

  const gaps: number[] = [];
  for (let i = 0; i < dates.length - 1; i++) {
    gaps.push((dates[i] - dates[i + 1]) / (1000 * 60 * 60 * 24));
  }

  const avgDays = gaps.reduce((sum, g) => sum + g, 0) / gaps.length;
  const lastRelease = new Date(dates[0]);
  const nextExpected = new Date(lastRelease.getTime() + avgDays * 24 * 60 * 60 * 1000);

  // Confidence based on variance
  const variance = gaps.reduce((sum, g) => sum + Math.pow(g - avgDays, 2), 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  const confidence = Math.max(0, Math.min(1, 1 - stdDev / avgDays));

  return {
    averageDaysBetweenReleases: Math.round(avgDays),
    lastReleaseDate: lastRelease.toISOString().split('T')[0],
    nextExpectedWindow: nextExpected.toISOString().split('T')[0],
    confidence: Math.round(confidence * 100) / 100,
  };
}

export async function getNewReleasesByLabel(
  env: Env,
  labelName: string,
  sinceDaysAgo = 7,
): Promise<SpotifyRelease[]> {
  // Search for recent releases with label filter
  const query = encodeURIComponent(`label:"${labelName}" tag:new`);
  const data = (await spotifyFetch(env, `/search?q=${query}&type=album&limit=50`)) as {
    albums: {
      items: Array<{
        name: string;
        release_date: string;
        album_type: string;
        total_tracks: number;
      }>;
    };
  };

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - sinceDaysAgo);

  return data.albums.items
    .filter((a) => new Date(a.release_date) >= cutoff)
    .map((a) => ({
      name: a.name,
      releaseDate: a.release_date,
      type: a.album_type as SpotifyRelease['type'],
      trackCount: a.total_tracks,
    }));
}

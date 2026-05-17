/**
 * Google OAuth — exchanges the long-lived refresh token for a short-lived
 * access token. The same OAuth client covers Gmail + Drive (scopes:
 * gmail.readonly + drive.readonly).
 *
 * Access tokens are cached in KV (or memory if KV not bound) until 5 min
 * before expiry to cut the round trips.
 */

import type { Env } from "../lib/env";

interface CachedToken {
  accessToken: string;
  expiresAt: number; // ms epoch
}

let memCache: CachedToken | null = null;

export async function getGoogleAccessToken(env: Env): Promise<string> {
  const now = Date.now();
  if (memCache && memCache.expiresAt - 300_000 > now) {
    return memCache.accessToken;
  }

  const body = new URLSearchParams({
    client_id: env.GMAIL_OAUTH_CLIENT_ID,
    client_secret: env.GMAIL_OAUTH_CLIENT_SECRET,
    refresh_token: env.GMAIL_OAUTH_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`google_token_refresh_failed: ${res.status} ${await res.text()}`);
  }

  const j = (await res.json()) as { access_token: string; expires_in: number };
  memCache = {
    accessToken: j.access_token,
    expiresAt: now + j.expires_in * 1000,
  };
  return j.access_token;
}

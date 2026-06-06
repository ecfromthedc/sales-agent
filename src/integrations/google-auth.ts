/**
 * google-auth — THE shared Google OAuth token broker for the monorepo.
 * (SALE-108)
 *
 * This module is the single source of truth for minting a Google access token.
 * Every Google integration in the repo (Gmail history + draft creation in
 * `gmail.ts`, Drive transcript polling in `google-drive.ts`) MUST obtain its
 * bearer token by calling the one exported primitive below —
 * {@link getGoogleAccessToken}. Do NOT inline a second refresh-token exchange
 * anywhere; route new Google callers through this export so there is exactly
 * one place that knows the OAuth client, scopes, endpoint, and cache policy.
 *
 * Contract (kept EXACTLY as-is — no behavior change):
 *   - OAuth client: one client covers both Gmail + Drive
 *     (scopes: `gmail.readonly` + `drive.readonly`; re-mint to add
 *     `gmail.compose` for draft writes — see gmail.ts SCOPE REQUIREMENT note).
 *   - Endpoint: exchanges the long-lived `GMAIL_OAUTH_REFRESH_TOKEN` at
 *     `https://oauth2.googleapis.com/token` (grant_type=refresh_token) for a
 *     short-lived access token.
 *   - Cache: the minted access token is cached in a process-local in-memory
 *     cache and reused until 5 min before its expiry, cutting redundant token
 *     round trips within a single Worker isolate.
 *   - HTTP: uses the shared {@link apiFetch} wrapper (SALE-106), which throws an
 *     `HttpError` (status + body) on a non-2xx token response.
 */

import { apiFetch } from "../lib/http";

/**
 * Minimal structural env for {@link getGoogleAccessToken} — exactly the OAuth
 * fields the refresh-token exchange reads. Narrowed from the concrete sales
 * `Env` (SALE-129) so shared primitives don't transitively pull in the full
 * Worker env. The sales `Env` is a structural superset, so every existing
 * caller still satisfies this.
 */
export interface GoogleAuthEnv {
  GMAIL_OAUTH_CLIENT_ID: string;
  GMAIL_OAUTH_CLIENT_SECRET: string;
  GMAIL_OAUTH_REFRESH_TOKEN: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // ms epoch
}

let memCache: CachedToken | null = null;

/**
 * Test-only: clear the in-memory access-token cache so each test starts from a
 * cold cache. Not used by production code paths. Mirrors the Spotify broker's
 * `__resetSpotifyTokenCache` so the token-exchange contract is unit-testable.
 */
export function __resetGoogleTokenCache(): void {
  memCache = null;
}

/**
 * Mint a Google access token for the monorepo's Gmail + Drive integrations.
 *
 * Returns a cached token when one is still valid (>5 min from expiry); otherwise
 * exchanges the refresh token for a fresh one, caches it, and returns it.
 *
 * @throws {import("../lib/http").HttpError} when the token endpoint returns non-2xx.
 */
export async function getGoogleAccessToken(env: GoogleAuthEnv): Promise<string> {
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

  // apiFetch parses the JSON body and throws an HttpError (carrying the status +
  // response text) on a non-2xx response — same observable behavior as the manual
  // fetch + !res.ok throw it replaces. No caller inspects the error message.
  const j = await apiFetch<{ access_token: string; expires_in: number }>(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );
  memCache = {
    accessToken: j.access_token,
    expiresAt: now + j.expires_in * 1000,
  };
  return j.access_token;
}

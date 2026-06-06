import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/lib/env";
import {
  __resetGoogleTokenCache,
  getGoogleAccessToken,
} from "../src/integrations/google-auth";

// SALE-108: google-auth.ts is THE shared Google OAuth token broker for the
// monorepo (Gmail + Drive consume getGoogleAccessToken). These tests lock the
// token-exchange + in-memory cache contract that gmail.ts and google-drive.ts
// both depend on:
//   - exchanges the refresh token at oauth2.googleapis.com/token
//     (grant_type=refresh_token, with the OAuth client id/secret) and returns
//     the access token
//   - caches the token in-memory (second call within TTL does not re-fetch)
//   - refreshes once the cached token is within 5 min of expiry
//   - throws when the token endpoint returns a non-OK response

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// Minimal Env — only the three secrets the token exchange reads. Cast keeps the
// test focused on the OAuth credentials without constructing the full binding set.
const env = {
  GMAIL_OAUTH_CLIENT_ID: "client-id",
  GMAIL_OAUTH_CLIENT_SECRET: "client-secret",
  GMAIL_OAUTH_REFRESH_TOKEN: "refresh-token",
} as unknown as Env;

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({ access_token: accessToken, expires_in: expiresIn }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetGoogleTokenCache();
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetGoogleTokenCache();
});

describe("getGoogleAccessToken (shared OAuth broker)", () => {
  it("exchanges the refresh token and returns the access token", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("token-abc"));

    const token = await getGoogleAccessToken(env);

    expect(token).toBe("token-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");

    // Body is a urlencoded refresh_token grant carrying the OAuth client creds.
    const params = new URLSearchParams(init.body as string);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("client-id");
    expect(params.get("client_secret")).toBe("client-secret");
    expect(params.get("refresh_token")).toBe("refresh-token");
  });

  it("caches the token — a second call within TTL does not re-fetch", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("token-abc", 3600));

    const first = await getGoogleAccessToken(env);
    const second = await getGoogleAccessToken(env);

    expect(first).toBe("token-abc");
    expect(second).toBe("token-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token once it is within 5 min of expiry", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-old", 3600))
      .mockResolvedValueOnce(tokenResponse("token-new", 3600));

    const first = await getGoogleAccessToken(env);
    expect(first).toBe("token-old");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Still cached at +50 min (>5 min from the 60 min expiry) → no re-fetch.
    vi.advanceTimersByTime(50 * 60_000);
    expect(await getGoogleAccessToken(env)).toBe("token-old");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Past the 5-min-before-expiry skew (now +56 min) → refreshes.
    vi.advanceTimersByTime(6 * 60_000);
    const refreshed = await getGoogleAccessToken(env);
    expect(refreshed).toBe("token-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the token endpoint returns an auth error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));

    await expect(getGoogleAccessToken(env)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

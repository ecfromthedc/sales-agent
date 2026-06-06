import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/lib/env";
import { __resetSpotifyTokenCache, getSpotifyToken } from "../src/integrations/spotify";

// SALE-105: the Spotify client-credentials token exchange + in-memory cache was
// extracted into getSpotifyToken(env). These tests lock its contract:
//   - exchanges credentials at accounts.spotify.com/api/token (Basic auth,
//     grant_type=client_credentials) and returns the access token
//   - caches the token in-memory (second call within TTL does not re-fetch)
//   - refreshes once the token's TTL has elapsed
//   - throws when the token endpoint returns a non-OK response

const TOKEN_URL = "https://accounts.spotify.com/api/token";

// Minimal Env — only the two secrets the token exchange reads. Cast keeps the
// test focused on the credentials without constructing the full binding set.
const env = {
  SPOTIFY_CLIENT_ID: "client-id",
  SPOTIFY_CLIENT_SECRET: "client-secret",
} as unknown as Env;

function tokenResponse(accessToken: string, expiresIn = 3600): Response {
  return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetSpotifyTokenCache();
  vi.useFakeTimers();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetSpotifyTokenCache();
});

describe("getSpotifyToken", () => {
  it("exchanges client credentials and returns the access token", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("token-abc"));

    const token = await getSpotifyToken(env);

    expect(token).toBe("token-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("grant_type=client_credentials");
    // Basic auth = base64("client-id:client-secret")
    expect(init.headers.authorization).toBe(`Basic ${btoa("client-id:client-secret")}`);
    expect(init.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  });

  it("caches the token — a second call within TTL does not re-fetch", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("token-abc", 3600));

    const first = await getSpotifyToken(env);
    const second = await getSpotifyToken(env);

    expect(first).toBe("token-abc");
    expect(second).toBe("token-abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes the token after it expires", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("token-old", 3600))
      .mockResolvedValueOnce(tokenResponse("token-new", 3600));

    const first = await getSpotifyToken(env);
    expect(first).toBe("token-old");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the full TTL (1h) so the cached token is considered expired.
    vi.advanceTimersByTime(3_600_000 + 1_000);

    const second = await getSpotifyToken(env);
    expect(second).toBe("token-new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws when the token endpoint returns an auth error", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 401 }));

    await expect(getSpotifyToken(env)).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

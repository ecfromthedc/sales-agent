import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, HttpError, DEFAULT_TIMEOUT_MS } from "../src/lib/http";

// SALE-106: apiFetch<T> is the shared typed fetch wrapper. These tests lock its
// contract:
//   - a 2xx response resolves to the parsed JSON body, typed as T
//   - a non-2xx response throws an HttpError carrying the status + response text
//   - the request times out via AbortController (default 20s, overridable),
//     and the abort surfaces as a thrown error
//   - method / headers / body are forwarded to the underlying fetch unchanged,
//     plus an AbortSignal

describe("apiFetch", () => {
  it("returns the parsed JSON body typed as T on a 2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "abc", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const out = await apiFetch<{ access_token: string; expires_in: number }>(
      "https://example.test/token",
      { fetchImpl },
    );

    expect(out).toEqual({ access_token: "abc", expires_in: 3600 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("forwards method, headers, and body (plus a signal) to the underlying fetch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiFetch("https://example.test/things", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
      fetchImpl,
    });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/things");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      authorization: "Bearer t",
      "content-type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws an HttpError carrying status + response text on a non-2xx response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("invalid_client", { status: 401 }),
    );

    const err = await apiFetch("https://example.test/token", { fetchImpl }).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as HttpError).responseText).toBe("invalid_client");
    expect((err as HttpError).message).toMatch(/401/);
  });

  it("aborts and throws when the request exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that never resolves on its own — only the abort signal ends it.
      const fetchImpl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );

      const promise = apiFetch("https://example.test/slow", {
        timeoutMs: 50,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      // Attach a catch synchronously so the rejection is never unhandled.
      const settled = promise.then(
        () => ({ ok: true as const }),
        (e) => ({ ok: false as const, error: e }),
      );

      await vi.advanceTimersByTimeAsync(50);

      const result = await settled;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect((result.error as Error).name).toBe("AbortError");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not abort when the response arrives before the timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

      const out = await apiFetch<{ ok: boolean }>("https://example.test/fast", {
        timeoutMs: 1000,
        fetchImpl,
      });

      expect(out).toEqual({ ok: true });
      // The pending abort timer is cleared; advancing past it is a no-op.
      vi.advanceTimersByTime(2000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes a 20s default timeout", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(20_000);
  });
});

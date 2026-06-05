import { describe, it, expect, vi } from "vitest";
import { retry, computeBackoff } from "../src/lib/retry";

// Deterministic, instant sleep so tests don't actually wait. We capture the
// requested delays to assert on backoff ordering.
function makeSpySleep() {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

describe("retry", () => {
  it("returns immediately on first success (no sleep, single call)", async () => {
    const { sleep, delays } = makeSpySleep();
    const fn = vi.fn(async () => "ok");

    const result = await retry(fn, { retries: 3, sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]); // never backed off
  });

  it("succeeds after transient failures", async () => {
    const { sleep, delays } = makeSpySleep();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error(`transient ${calls}`);
      return "recovered";
    });

    const result = await retry(fn, { retries: 3, sleep, jitter: 0 });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3); // 2 failures + 1 success
    expect(delays).toHaveLength(2); // backed off twice
  });

  it("gives up after max retries and rethrows the last error", async () => {
    const { sleep, delays } = makeSpySleep();
    const fn = vi.fn(async () => {
      throw new Error("always fails");
    });

    await expect(retry(fn, { retries: 2, sleep })).rejects.toThrow("always fails");
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(delays).toHaveLength(2); // one backoff before each retry
  });

  it("respects exponential backoff ordering (each delay grows)", async () => {
    const { sleep, delays } = makeSpySleep();
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });

    await expect(
      retry(fn, {
        retries: 3,
        baseDelayMs: 100,
        factor: 2,
        jitter: 0, // disable jitter for deterministic assertions
        sleep,
      }),
    ).rejects.toThrow("nope");

    // attempts 1,2,3 each back off before the next try → 3 delays
    expect(delays).toEqual([100, 200, 400]);
    // strictly increasing
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("caps backoff at maxDelayMs", async () => {
    const { sleep, delays } = makeSpySleep();
    const fn = vi.fn(async () => {
      throw new Error("nope");
    });

    await expect(
      retry(fn, {
        retries: 5,
        baseDelayMs: 1000,
        factor: 10,
        maxDelayMs: 3000,
        jitter: 0,
        sleep,
      }),
    ).rejects.toThrow();

    // 1000, then 10000→capped 3000, then capped 3000, ...
    expect(delays[0]).toBe(1000);
    for (const d of delays.slice(1)) {
      expect(d).toBeLessThanOrEqual(3000);
    }
  });

  it("does not retry when shouldRetry returns false (fast-fail non-transient)", async () => {
    const { sleep, delays } = makeSpySleep();
    const fn = vi.fn(async () => {
      throw new Error("401 unauthorized");
    });

    await expect(
      retry(fn, {
        retries: 5,
        sleep,
        shouldRetry: (err) => !/401/.test((err as Error).message),
      }),
    ).rejects.toThrow("401");

    expect(fn).toHaveBeenCalledTimes(1); // bailed immediately
    expect(delays).toEqual([]);
  });

  it("passes the attempt number to fn (1-based)", async () => {
    const { sleep } = makeSpySleep();
    const seen: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 3) throw new Error("retry me");
      return attempt;
    });

    const result = await retry(fn, { retries: 5, sleep, jitter: 0 });

    expect(result).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("invokes onRetry before each backoff with error + attempt + delay", async () => {
    const { sleep } = makeSpySleep();
    const events: Array<{ attempt: number; delayMs: number }> = [];
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(
      retry(fn, {
        retries: 2,
        baseDelayMs: 50,
        factor: 2,
        jitter: 0,
        sleep,
        onRetry: (_err, attempt, delayMs) => events.push({ attempt, delayMs }),
      }),
    ).rejects.toThrow("boom");

    expect(events).toEqual([
      { attempt: 1, delayMs: 50 },
      { attempt: 2, delayMs: 100 },
    ]);
  });

  it("treats a resolved null as success (does not retry swallowed failures)", async () => {
    const { sleep, delays } = makeSpySleep();
    const fn = vi.fn(async () => null);

    const result = await retry(fn, { retries: 3, sleep });

    expect(result).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });
});

describe("computeBackoff", () => {
  const base = { baseDelayMs: 100, maxDelayMs: 5000, factor: 2 };

  it("grows exponentially with no jitter", () => {
    expect(computeBackoff(1, { ...base, jitter: 0 })).toBe(100);
    expect(computeBackoff(2, { ...base, jitter: 0 })).toBe(200);
    expect(computeBackoff(3, { ...base, jitter: 0 })).toBe(400);
  });

  it("caps at maxDelayMs", () => {
    expect(computeBackoff(10, { ...base, jitter: 0 })).toBe(5000);
  });

  it("stays within the jitter band", () => {
    for (let i = 0; i < 100; i++) {
      const d = computeBackoff(3, { ...base, jitter: 0.25 });
      // expected center 400, ±25% → [300, 500]
      expect(d).toBeGreaterThanOrEqual(300);
      expect(d).toBeLessThanOrEqual(500);
    }
  });
});

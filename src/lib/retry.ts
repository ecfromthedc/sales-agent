/**
 * retry — reusable async retry with exponential backoff + jitter.
 *
 * Built for enrichment calls (Spotify, Songstats, Chartmetric, Gmail) that can
 * fail transiently (network blips, 429/5xx). Wraps a thrown-on-failure async fn
 * and re-invokes it up to `retries` extra times, backing off exponentially with
 * jitter between attempts.
 *
 * Workers-compatible: no Node APIs. Sleeps via `await new Promise(r => setTimeout(r, ms))`
 * (`setTimeout` is available in the Workers runtime).
 *
 * Design notes:
 *   - Only retries on a THROW. A function that resolves (incl. resolving `null`)
 *     is treated as success and returned as-is — so integrations that already
 *     swallow failures into `null` keep their exact current behavior.
 *   - `shouldRetry` lets callers skip retries on non-transient errors (e.g. a
 *     4xx auth failure that will never succeed). Default: retry on any throw.
 *   - Designed to live inside `Promise.allSettled` — when retries are exhausted
 *     the last error rethrows, so one failing source surfaces as a rejected
 *     settled result without blocking the others.
 */

export interface RetryOptions {
  /** Number of RETRIES after the first attempt. retries=2 → up to 3 total attempts. */
  retries?: number;
  /** Base delay in ms for the first backoff (attempt 1 → baseDelayMs). */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay, before jitter. */
  maxDelayMs?: number;
  /** Exponential growth factor. delay = baseDelayMs * factor^(attempt-1). */
  factor?: number;
  /** Jitter ratio [0,1]: actual delay is in [delay*(1-jitter), delay*(1+jitter)]. */
  jitter?: number;
  /** Decide whether a thrown error is worth retrying. Default: always retry. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each backoff sleep — useful for logging / tests. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Injectable sleeper (tests override this; defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  retries: 2,
  baseDelayMs: 300,
  maxDelayMs: 8000,
  factor: 2,
  jitter: 0.25,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Compute the backoff delay (ms) for a given attempt number (1-based).
 * Exponential growth, capped at maxDelayMs, then ±jitter applied.
 */
export function computeBackoff(
  attempt: number,
  opts: Required<Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "factor" | "jitter">>,
): number {
  const raw = opts.baseDelayMs * Math.pow(opts.factor, attempt - 1);
  const capped = Math.min(raw, opts.maxDelayMs);
  if (opts.jitter <= 0) return Math.round(capped);
  const spread = capped * opts.jitter;
  // Uniform in [capped - spread, capped + spread]
  const delta = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(capped + delta));
}

/**
 * Run `fn`, retrying on throw with exponential backoff + jitter.
 *
 * @returns the resolved value of `fn` on the first successful attempt.
 * @throws the last error if every attempt fails (or `shouldRetry` returns false).
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULTS.retries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const factor = options.factor ?? DEFAULTS.factor;
  const jitter = options.jitter ?? DEFAULTS.jitter;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown;

  // attempt is 1-based; total attempts = retries + 1.
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt > retries;
      if (isLastAttempt || !shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = computeBackoff(attempt, { baseDelayMs, maxDelayMs, factor, jitter });
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  // Unreachable — the loop either returns or throws. Present for the type checker.
  throw lastError;
}

/**
 * http — a small typed `fetch` wrapper for outbound JSON API calls.
 *
 * Centralizes the three things almost every integration call site repeats:
 *   1. JSON parsing of the response body into a caller-supplied type `T`.
 *   2. Non-2xx → a typed `HttpError` carrying the status code and raw body text,
 *      so callers can branch on `err.status` (e.g. treat 404 as "not found")
 *      without re-parsing an error string.
 *   3. A request timeout via `AbortController`, so a hung upstream can't stall a
 *      Worker invocation indefinitely.
 *
 * Workers-compatible: uses only `fetch`, `AbortController`, and `setTimeout`,
 * all available in the Cloudflare Workers runtime. No Node-only APIs.
 *
 * Design notes:
 *   - `fetch` is injectable (defaults to the global). Tests pass a fake fetch
 *     instead of stubbing globals, mirroring the `sleep` injection in `retry.ts`.
 *   - On a non-2xx response the body text is read once and attached to the
 *     thrown `HttpError` — callers get the status AND the upstream error detail.
 *   - The abort timer is always cleared in a `finally`, even on throw, so we
 *     never leak a pending timer.
 */

/** Default request timeout (ms) before the AbortController fires. */
export const DEFAULT_TIMEOUT_MS = 20_000;

/** Options for {@link apiFetch}. Mirrors the relevant subset of `RequestInit`. */
export interface ApiFetchOptions {
  /** HTTP method. Defaults to GET. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body (string for JSON/form payloads, or any BodyInit). */
  body?: BodyInit | null;
  /** Abort the request after this many ms. Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable fetch (tests override this; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

/**
 * Error thrown by {@link apiFetch} when the response status is not 2xx.
 *
 * Carries the numeric `status` and the raw response `responseText` so callers
 * can branch on the status code (e.g. `if (err.status === 404)`) and surface the
 * upstream error body for logging.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly responseText: string;
  readonly url: string;

  constructor(status: number, responseText: string, url: string) {
    super(`HTTP ${status} for ${url}: ${responseText.slice(0, 400)}`);
    this.name = "HttpError";
    this.status = status;
    this.responseText = responseText;
    this.url = url;
  }
}

/**
 * Fetch `url`, returning the parsed JSON body typed as `T`.
 *
 * @throws {HttpError} when the response status is not 2xx (carries status + body text).
 * @throws the underlying fetch rejection (incl. an `AbortError` on timeout).
 *
 * Note: the response body is assumed to be JSON. A 2xx response with an empty or
 * non-JSON body will reject from `response.json()`; callers that expect empty
 * bodies should not use this helper for those calls.
 */
export async function apiFetch<T>(url: string, options: ApiFetchOptions = {}): Promise<T> {
  const { method = "GET", headers, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await doFetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      // Read the body once for the error detail; tolerate a body that can't be read.
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text, url);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

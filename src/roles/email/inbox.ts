/**
 * src/roles/email/inbox.ts — read-only Gmail inbox triage digest.
 *
 * Pulls the most recent inbox messages from Gmail and runs each through the
 * pure {@link classifyEmail} classifier (SALE-117), bucketing them into the
 * four triage tiers. The result is a {@link InboxDigest} — a quick "what's in
 * the inbox right now" snapshot for a human to skim.
 *
 * STRICTLY READ-ONLY (SALE-118):
 *   - Only ever calls `users.messages.list` + `users.messages.get`.
 *   - NEVER touches drafts / send / modify / trash / labels.
 *   - The shared OAuth token already holds `gmail.readonly`, so no re-scope is
 *     needed (unlike the draft path in `gmail.ts`).
 *
 * Reuse of `src/shared`:
 *   - `getGoogleAccessToken` — the single Google OAuth token broker (SALE-108).
 *   - `apiFetch` — the typed `fetch` wrapper (SALE-106): JSON parsing, typed
 *     `HttpError` on non-2xx, and an `AbortController` timeout.
 *
 * Workers-compatible: only `fetch` (via the shared wrapper) — no Node APIs.
 */

import type { Env } from "../../lib/env";
// SALE-109: pull the cross-role primitives through the shared barrel rather than
// reaching into ../../integrations / ../../lib directly.
import { apiFetch, getGoogleAccessToken } from "../../shared";
import { classifyEmail } from "./triage";
import type { EmailInput, EmailTier } from "./triage";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Default number of inbox messages to pull when no `max` is given. */
export const DEFAULT_MAX_MESSAGES = 25;

/** A single triaged inbox message: the classifier's verdict + display fields. */
export interface TriagedMsg {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  tier: EmailTier;
  reasons: string[];
}

/** The inbox digest: messages bucketed by triage tier (highest concern first). */
export interface InboxDigest {
  action_required: TriagedMsg[];
  meeting_info: TriagedMsg[];
  info_only: TriagedMsg[];
  skip: TriagedMsg[];
}

export interface TriageInboxOptions {
  /** Max messages to pull from the inbox. Defaults to {@link DEFAULT_MAX_MESSAGES}. */
  max?: number;
  /** Injectable fetch (tests override this; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

// --- Gmail API response shapes (only the fields we read) -------------------

interface GmailListResponse {
  messages?: Array<{ id: string; threadId?: string }>;
  resultSizeEstimate?: number;
}

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailGetResponse {
  id: string;
  snippet?: string;
  payload?: { headers?: GmailHeader[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a case-insensitive header map from Gmail's `[{name,value}]` array. */
function headersToMap(headers: GmailHeader[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!headers) return map;
  for (const h of headers) {
    if (h && typeof h.name === "string") map[h.name] = h.value ?? "";
  }
  return map;
}

/** First header value (case-insensitive) or empty string. */
function headerValue(map: Record<string, string>, name: string): string {
  const want = name.toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === want) return map[key] ?? "";
  }
  return "";
}

/**
 * Map a single Gmail `messages.get` (format=full/metadata) response into the
 * pure classifier's {@link EmailInput} shape, then classify it.
 */
function triageMessage(msg: GmailGetResponse): TriagedMsg {
  const headers = headersToMap(msg.payload?.headers);
  const from = headerValue(headers, "From");
  const subject = headerValue(headers, "Subject");
  const snippet = msg.snippet ?? "";

  const input: EmailInput = { from, subject, snippet, headers };
  const { tier, reasons } = classifyEmail(input);

  return { id: msg.id, from, subject, snippet, tier, reasons };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a read-only triage digest of the current Gmail inbox.
 *
 * Flow:
 *   1. Mint a Google access token via the shared broker (gmail.readonly).
 *   2. `messages.list?q=in:inbox&maxResults=<max>` → message ids.
 *   3. For each id, `messages.get?format=metadata` (From + Subject headers +
 *      snippet) — enough for the classifier, and avoids pulling message bodies.
 *   4. Run each through `classifyEmail` and bucket by tier.
 *
 * Partial `get` failures are tolerated (`Promise.allSettled`): one unreadable
 * message never sinks the whole digest.
 *
 * @returns the four-tier {@link InboxDigest}.
 */
export async function triageInbox(
  env: Env,
  opts: TriageInboxOptions = {},
): Promise<InboxDigest> {
  const max = opts.max && opts.max > 0 ? Math.floor(opts.max) : DEFAULT_MAX_MESSAGES;
  const fetchImpl = opts.fetchImpl;

  const token = await getGoogleAccessToken(env);
  const authHeaders = { authorization: `Bearer ${token}` };

  // 1. List inbox message ids (READ-ONLY: messages.list).
  const listParams = new URLSearchParams({ q: "in:inbox", maxResults: String(max) });
  const list = await apiFetch<GmailListResponse>(
    `${GMAIL_API}/messages?${listParams.toString()}`,
    { method: "GET", headers: authHeaders, fetchImpl },
  );

  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));

  // 2. Fetch metadata for each id (READ-ONLY: messages.get, format=metadata).
  const metaParams = (id: string) => {
    const p = new URLSearchParams({ format: "metadata" });
    p.append("metadataHeaders", "From");
    p.append("metadataHeaders", "Subject");
    p.append("metadataHeaders", "List-Unsubscribe");
    p.append("metadataHeaders", "List-Id");
    p.append("metadataHeaders", "Precedence");
    p.append("metadataHeaders", "Auto-Submitted");
    p.append("metadataHeaders", "In-Reply-To");
    p.append("metadataHeaders", "References");
    return `${GMAIL_API}/messages/${encodeURIComponent(id)}?${p.toString()}`;
  };

  const results = await Promise.allSettled(
    ids.map((id) =>
      apiFetch<GmailGetResponse>(metaParams(id), {
        method: "GET",
        headers: authHeaders,
        fetchImpl,
      }),
    ),
  );

  const digest: InboxDigest = {
    action_required: [],
    meeting_info: [],
    info_only: [],
    skip: [],
  };

  for (const r of results) {
    if (r.status !== "fulfilled") continue; // partial failure → skip that one
    const triaged = triageMessage(r.value);
    digest[triaged.tier].push(triaged);
  }

  return digest;
}

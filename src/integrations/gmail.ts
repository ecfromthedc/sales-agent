/**
 * Gmail history search — finds past convos with a prospect's email or domain.
 *
 * All Gmail calls authenticate via the shared OAuth token broker
 * (`getGoogleAccessToken` in ./google-auth — SALE-108). This module holds NO
 * token-exchange logic of its own; same OAuth client as Drive.
 */

import type { Env } from "../lib/env";
// SALE-109: import the auth primitive via the shared barrel (cross-role surface)
// rather than reaching into ./google-auth directly.
import { getGoogleAccessToken } from "../shared";

export interface GmailHistory {
  threadCount: number;
  domainThreadCount: number;
  mostRecentSubject?: string;
  mostRecentDate?: string;
  threads: Array<{ id: string; subject: string; snippet: string; date: string }>;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

// ---------------------------------------------------------------------------
// Draft creation (approval gate — SALE-63)
//
// We create a Gmail DRAFT only. There is deliberately NO send path in this
// module: a human (Eric) reviews every follow-up in Gmail and presses send.
//
// SCOPE REQUIREMENT — IMPORTANT:
//   The shared GMAIL_OAUTH_REFRESH_TOKEN is currently minted with
//   `gmail.readonly` + `drive.readonly` (see FINISH_SETUP_BROWSER_PROMPT.md).
//   `users.drafts.create` requires WRITE scope. This call will 403 until the
//   refresh token is re-minted with `gmail.compose` (or `gmail.modify`).
//   The code below is correct and guarded so it can't break the pitch flow;
//   it simply will not succeed until the token is re-scoped. Re-mint via the
//   same OAuth consent flow used in FINISH_SETUP_BROWSER_PROMPT.md, adding:
//     https://www.googleapis.com/auth/gmail.compose
// ---------------------------------------------------------------------------

export interface GmailDraftInput {
  to: string;
  from: string;
  subject: string;
  body: string;
}

export interface GmailDraftResult {
  draftId: string;
  messageId?: string;
}

/**
 * Base64url-encode a UTF-8 string the way the Gmail API expects raw messages:
 * standard base64, then `+`→`-`, `/`→`_`, and stripped `=` padding.
 * Workers-compatible (uses `btoa`; no Node Buffer).
 */
export function base64UrlEncode(input: string): string {
  // btoa operates on Latin-1; encodeURIComponent + unescape round-trips UTF-8
  // into a byte string btoa can handle (so accents/emoji in the body survive).
  const bytes = unescape(encodeURIComponent(input));
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** Fold a header value and drop CR/LF so callers can't inject extra headers. */
function sanitizeHeader(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Build an RFC822 MIME message (plain-text, UTF-8) from a draft input.
 * PURE + side-effect-free so it is trivially unit-testable. Produces only the
 * standard draft headers — there is intentionally no Bcc/auto-send field and
 * nothing that would cause Gmail to dispatch the message.
 */
export function buildMimeMessage(input: GmailDraftInput): string {
  const headers = [
    `From: ${sanitizeHeader(input.from)}`,
    `To: ${sanitizeHeader(input.to)}`,
    `Subject: ${sanitizeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  // CRLF line endings per RFC822; blank line separates headers from body.
  return headers.join("\r\n") + "\r\n\r\n" + input.body;
}

/**
 * Create a Gmail DRAFT (never send). Calls `users.drafts.create` with a raw
 * base64url-encoded RFC822 message. Returns the created draft id.
 *
 * Throws on non-2xx (including the expected 403 while the token is still
 * read-only scoped — see the SCOPE REQUIREMENT note above). Callers in the
 * pitch flow guard this so a draft failure never breaks pitch artifacts.
 */
export async function createGmailDraft(
  env: Env,
  input: GmailDraftInput,
): Promise<GmailDraftResult> {
  const token = await getGoogleAccessToken(env);
  const raw = base64UrlEncode(buildMimeMessage(input));

  const res = await fetch(`${GMAIL_API}/drafts`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message: { raw } }),
  });

  if (!res.ok) {
    throw new Error(
      `gmail_draft_create_failed: ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as { id?: string; message?: { id?: string } };
  if (!data.id) throw new Error("gmail_draft_create_no_id");
  return { draftId: data.id, messageId: data.message?.id };
}

export async function searchGmailHistory(
  inviteeEmail: string,
  env: Env,
): Promise<GmailHistory> {
  const token = await getGoogleAccessToken(env);
  const domain = inviteeEmail.split("@")[1] ?? "";

  // Two passes: exact email, then domain (catches manager <-> artist mismatches).
  const exact = await listThreads(`from:${inviteeEmail} OR to:${inviteeEmail}`, token, 10);
  const domainQuery = domain ? `(from:@${domain} OR to:@${domain})` : null;
  const domainHits = domainQuery
    ? await listThreads(domainQuery, token, 10)
    : { resultSizeEstimate: 0, threads: [] };

  const enriched = await Promise.all(
    exact.threads.slice(0, 5).map((t) => getThread(t.id, token)),
  );

  const mostRecent = enriched[0];
  return {
    threadCount: exact.resultSizeEstimate,
    domainThreadCount: domainHits.resultSizeEstimate,
    mostRecentSubject: mostRecent?.subject,
    mostRecentDate: mostRecent?.date,
    threads: enriched.filter((t): t is NonNullable<typeof t> => Boolean(t)),
  };
}

async function listThreads(q: string, token: string, maxResults: number) {
  const params = new URLSearchParams({ q, maxResults: String(maxResults) });
  const res = await fetch(`${GMAIL_API}/threads?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { resultSizeEstimate: 0, threads: [] as Array<{ id: string }> };
  const data = (await res.json()) as {
    resultSizeEstimate?: number;
    threads?: Array<{ id: string }>;
  };
  return {
    resultSizeEstimate: data.resultSizeEstimate ?? 0,
    threads: data.threads ?? [],
  };
}

async function getThread(threadId: string, token: string) {
  const res = await fetch(
    `${GMAIL_API}/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=Date`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const t = (await res.json()) as {
    id: string;
    snippet?: string;
    messages?: Array<{ payload?: { headers?: Array<{ name: string; value: string }> } }>;
  };
  const headers = t.messages?.[0]?.payload?.headers ?? [];
  const subject = headers.find((h) => h.name === "Subject")?.value ?? "";
  const date = headers.find((h) => h.name === "Date")?.value ?? "";
  return {
    id: t.id,
    subject,
    snippet: t.snippet ?? "",
    date,
  };
}

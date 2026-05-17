/**
 * Gmail history search — finds past convos with a prospect's email or domain.
 * Uses the shared Google OAuth refresh token; same client as Drive.
 */

import type { Env } from "../lib/env";
import { getGoogleAccessToken } from "./google-auth";

export interface GmailHistory {
  threadCount: number;
  domainThreadCount: number;
  mostRecentSubject?: string;
  mostRecentDate?: string;
  threads: Array<{ id: string; subject: string; snippet: string; date: string }>;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

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
  return res.json() as Promise<{
    resultSizeEstimate: number;
    threads: Array<{ id: string }>;
  }>;
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

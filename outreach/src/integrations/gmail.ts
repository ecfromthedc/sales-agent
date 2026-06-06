// Cross-Worker dedup (SALE-132): Henry's Google OAuth refresh-token exchange now
// lives in exactly one place — the shared `getGoogleAccessToken` broker (SALE-108,
// Env-decoupled in SALE-129, takes a minimal `GoogleAuthEnv { GMAIL_OAUTH_CLIENT_ID,
// GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN }`). Henry's `Env` is a
// structural superset, so callers pass `env` unchanged. Behavior is preserved:
// same token endpoint (oauth2.googleapis.com/token), same grant_type=refresh_token
// and client_id/secret/refresh_token field set, in-memory cached token reuse. The
// only difference from Henry's prior local fn is the cache pre-expiry margin
// (shared: 5 min; Henry's was 60 s) — both are valid refresh semantics. Imported
// directly (NOT the `../../../src/shared` barrel) to avoid pulling in unrelated
// shared deps.
import { getGoogleAccessToken } from '../../../src/integrations/google-auth';
import type { Env } from '../lib/env';

async function getGmailToken(env: Env): Promise<string> {
  return getGoogleAccessToken(env);
}

/**
 * Search Gmail for past conversations with an email address.
 * Returns snippet summaries of recent threads.
 */
export async function getEmailHistory(env: Env, email: string, maxResults = 5): Promise<string[]> {
  const token = await getGmailToken(env);
  const query = encodeURIComponent(`from:${email} OR to:${email}`);

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${query}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) return [];
  const data = (await response.json()) as { threads?: Array<{ id: string; snippet: string }> };

  if (!data.threads) return [];

  return data.threads.map((t) => t.snippet);
}

/**
 * Search Gmail for conversations mentioning a label or artist name.
 */
export async function searchEmailsByName(env: Env, name: string, maxResults = 5): Promise<string[]> {
  const token = await getGmailToken(env);
  const query = encodeURIComponent(name);

  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${query}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) return [];
  const data = (await response.json()) as { threads?: Array<{ id: string; snippet: string }> };

  if (!data.threads) return [];

  return data.threads.map((t) => t.snippet);
}

/**
 * Archive emails matching a Gmail search query by removing the INBOX label.
 * Returns the count of messages archived.
 */
export async function archiveEmailsByQuery(env: Env, query: string, maxResults = 100): Promise<number> {
  const token = await getGmailToken(env);

  // Find messages matching the query
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!response.ok) return 0;
  const data = (await response.json()) as { messages?: Array<{ id: string }> };

  if (!data.messages || data.messages.length === 0) return 0;

  // Batch modify — remove INBOX label (= archive)
  const batchResponse = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ids: data.messages.map((m) => m.id),
        removeLabelIds: ['INBOX'],
      }),
    },
  );

  if (!batchResponse.ok) {
    throw new Error(`Gmail batchModify failed: ${batchResponse.status}`);
  }

  return data.messages.length;
}

/**
 * Create a draft email in Gmail (does NOT send — Eric reviews and sends manually).
 */
export async function createGmailDraft(
  env: Env,
  to: string,
  subject: string,
  body: string,
): Promise<string> {
  const token = await getGmailToken(env);

  const rawMessage = btoa(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: { raw: rawMessage },
    }),
  });

  if (!response.ok) throw new Error(`Gmail draft creation failed: ${response.status}`);
  const data = (await response.json()) as { id: string };
  return data.id;
}

import type { Env } from '../lib/env';

interface GmailTokens {
  access_token: string;
  expires_at: number;
}

let gmailTokenCache: GmailTokens | null = null;

async function getGmailToken(env: Env): Promise<string> {
  if (gmailTokenCache && Date.now() < gmailTokenCache.expires_at) {
    return gmailTokenCache.access_token;
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_OAUTH_CLIENT_ID,
      client_secret: env.GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: env.GMAIL_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) throw new Error(`Gmail OAuth refresh failed: ${response.status}`);
  const data = (await response.json()) as { access_token: string; expires_in: number };

  gmailTokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };

  return data.access_token;
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

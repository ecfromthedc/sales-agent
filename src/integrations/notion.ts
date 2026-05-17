/**
 * Notion CRUD for the Sales Pipeline section.
 *
 * Uses raw fetch — @notionhq/client uses Node internals that don't work in
 * Cloudflare Workers.
 *
 * Three databases (created during Day-1 schema setup):
 *   - Deals             (one row per Calendly booking)
 *   - Transcripts       (one row per call)
 *   - Pitch Artifacts   (one row per generated deck/email)
 */

import type { Env } from "../lib/env";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function notionFetch(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.NOTION_API_KEY}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`notion_${res.status}_${method}_${path}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

// ---------- Types ----------
export interface Deal {
  id: string;
  inviteeEmail: string;
  inviteeName: string;
  eventStartsAt: string;
  eventUri: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
  status: "Booked" | "Briefed" | "Called" | "Pitched" | "Won" | "Lost";
  meetingTitle?: string;
  startedAt?: string;
  endedAt?: string;
  transcript?: string;
}

export interface DealUpsertInput {
  dealId?: string;
  inviteeEmail: string;
  inviteeName: string;
  eventStartsAt: string;
  eventUri: string;
  questionsAndAnswers: Array<{ question: string; answer: string }>;
  status: Deal["status"];
  brief?: string;
  enrichment?: unknown;
}

// ---------- Helpers ----------
function shortDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

function splitParagraphs(text: string): any[] {
  return text.split(/\n\n+/).filter(Boolean).map((p) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: p.slice(0, 1900) } }] },
  }));
}

function heading(text: string, level: 2 | 3 = 3): any {
  const key = `heading_${level}` as const;
  return {
    object: "block",
    type: key,
    [key]: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function bullet(text: string): any {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [{ type: "text", text: { content: text.slice(0, 1900) } }] },
  };
}

// ---------- Deals ----------
export async function upsertDeal(input: DealUpsertInput, env: Env): Promise<string> {
  // Dedupe by invitee email + eventUri.
  const existing = await notionFetch(env, "POST", `/databases/${env.NOTION_DEALS_DB_ID}/query`, {
    filter: {
      and: [
        { property: "Invitee Email", email: { equals: input.inviteeEmail } },
        { property: "Event URI", url: { equals: input.eventUri } },
      ],
    },
    page_size: 1,
  });

  const properties: Record<string, any> = {
    Name: { title: [{ text: { content: `${input.inviteeName} — ${shortDate(input.eventStartsAt)}` } }] },
    "Invitee Email": { email: input.inviteeEmail },
    "Invitee Name": { rich_text: [{ text: { content: input.inviteeName } }] },
    "Event Starts At": { date: { start: input.eventStartsAt } },
    "Event URI": { url: input.eventUri },
    Status: { select: { name: input.status } },
  };

  // Pull Spotify link from Q&A and stash it on the deal record.
  const spotifyAnswer = input.questionsAndAnswers.find((qa) => /spotify/i.test(qa.question))?.answer;
  if (spotifyAnswer) properties["Spotify Link"] = { url: spotifyAnswer.trim() };

  let pageId: string;
  if (existing.results && existing.results.length > 0) {
    pageId = existing.results[0].id;
    await notionFetch(env, "PATCH", `/pages/${pageId}`, { properties });
  } else {
    const created = await notionFetch(env, "POST", "/pages", {
      parent: { database_id: env.NOTION_DEALS_DB_ID },
      properties,
    });
    pageId = created.id;
  }

  if (input.brief) await appendBriefBlocks(pageId, input.brief, env);
  return pageId;
}

async function appendBriefBlocks(pageId: string, brief: string, env: Env): Promise<void> {
  await notionFetch(env, "PATCH", `/blocks/${pageId}/children`, {
    children: [heading("Pre-Call Brief", 2), ...splitParagraphs(brief)],
  });
}

export async function getDealById(_dealId: string, _env: Env): Promise<Deal | null> {
  // TODO: hydrate full Deal shape from a Notion page get + transcript fetch.
  return null;
}

export async function resolveDealForMeeting(
  q: { attendees: Array<{ email: string }>; startedAt: string },
  env: Env,
): Promise<{ id: string } | null> {
  const externalAttendee = q.attendees.find((a) => !a.email.endsWith("@risingtidesent.com"));
  if (!externalAttendee) return null;

  const startWindow = new Date(q.startedAt);
  const lower = new Date(startWindow.getTime() - 60 * 60 * 1000).toISOString();
  const upper = new Date(startWindow.getTime() + 60 * 60 * 1000).toISOString();

  const res = await notionFetch(env, "POST", `/databases/${env.NOTION_DEALS_DB_ID}/query`, {
    filter: {
      and: [
        { property: "Invitee Email", email: { equals: externalAttendee.email } },
        { property: "Event Starts At", date: { on_or_after: lower } },
        { property: "Event Starts At", date: { on_or_before: upper } },
      ],
    },
    page_size: 1,
  });

  return res.results?.[0] ? { id: res.results[0].id } : null;
}

// ---------- Transcripts ----------
export async function saveTranscript(input: {
  dealId: string;
  transcript: string;
  summary?: string;
  startedAt: string;
  endedAt: string;
  sourceUrl?: string;
}, env: Env): Promise<void> {
  const properties: Record<string, any> = {
    Name: { title: [{ text: { content: `Transcript ${shortDate(input.startedAt)}` } }] },
    Deal: { relation: [{ id: input.dealId }] },
    "Started At": { date: { start: input.startedAt, end: input.endedAt } },
    Summary: { rich_text: [{ text: { content: (input.summary ?? "").slice(0, 1900) } }] },
    Source: { select: { name: "Google Meet (Gemini)" } },
  };

  const children: any[] = [];
  if (input.sourceUrl) {
    children.push({
      object: "block",
      type: "bookmark",
      bookmark: { url: input.sourceUrl, caption: [{ text: { content: "Source file in Drive" } }] },
    });
  }
  children.push(...splitParagraphs(input.transcript));

  await notionFetch(env, "POST", "/pages", {
    parent: { database_id: env.NOTION_TRANSCRIPTS_DB_ID },
    properties,
    children,
  });
}

// ---------- Pitch Artifacts ----------
export async function attachPitchArtifacts(input: {
  dealId: string;
  pdfKey: string;
  emailDraft: string;
  actionItems: string[];
  transcriptQuoted: string[];
}, env: Env): Promise<void> {
  const properties: Record<string, any> = {
    Name: { title: [{ text: { content: `Pitch — ${new Date().toISOString().slice(0, 10)}` } }] },
    Deal: { relation: [{ id: input.dealId }] },
    "PDF Key": { rich_text: [{ text: { content: input.pdfKey } }] },
    Status: { select: { name: "Draft" } },
  };

  const children: any[] = [
    heading("Follow-Up Email Draft", 3),
    ...splitParagraphs(input.emailDraft),
    heading("Action Items (Internal)", 3),
    ...input.actionItems.map(bullet),
    heading("Transcript Lines Quoted in Deck", 3),
    ...input.transcriptQuoted.map((q) => bullet(`"${q}"`)),
  ];

  await notionFetch(env, "POST", "/pages", {
    parent: { database_id: env.NOTION_PITCH_ARTIFACTS_DB_ID },
    properties,
    children,
  });

  // Flip deal status: -> Pitched
  await notionFetch(env, "PATCH", `/pages/${input.dealId}`, {
    properties: { Status: { select: { name: "Pitched" } } },
  });
}

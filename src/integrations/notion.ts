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

export interface NotionFetchOptions {
  /** HTTP method. Defaults to "GET". */
  method?: string;
  /** Request body, JSON-stringified when present. */
  body?: unknown;
}

/**
 * Raw Notion API transport primitive — the single place that owns the base URL,
 * Authorization header, Notion-Version header, and JSON request/response handling.
 *
 * Every DB-specific query/CRUD helper in this module routes through here; there
 * are no stray inline Notion fetches.
 *
 * Error contract (relied on by callers — DO NOT change the format):
 * a non-2xx response throws `Error` with message
 *   `notion_${status}_${method}_${path}: <body excerpt>`
 * e.g. `getDealById` treats `notion_404_` as "not found" and returns null.
 */
export async function notionFetch(
  env: Env,
  path: string,
  opts: NotionFetchOptions = {},
): Promise<any> {
  const method = opts.method ?? "GET";
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.NOTION_API_KEY}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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
  brief?: string;
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

function codeBlocks(text: string, language = "html"): any[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += 1800) chunks.push(text.slice(i, i + 1800));
  return chunks.map((chunk) => ({
    object: "block",
    type: "code",
    code: {
      rich_text: [{ type: "text", text: { content: chunk } }],
      language,
    },
  }));
}

// ---------- Deals ----------
export async function upsertDeal(input: DealUpsertInput, env: Env): Promise<string> {
  // Dedupe by invitee email + eventUri.
  const existing = await notionFetch(env, `/databases/${env.NOTION_DEALS_DB_ID}/query`, {
    method: "POST",
    body: {
      filter: {
        and: [
          { property: "Invitee Email", email: { equals: input.inviteeEmail } },
          { property: "Event URI", url: { equals: input.eventUri } },
        ],
      },
      page_size: 1,
    },
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
    await notionFetch(env, `/pages/${pageId}`, { method: "PATCH", body: { properties } });
  } else {
    const created = await notionFetch(env, "/pages", {
      method: "POST",
      body: {
        parent: { database_id: env.NOTION_DEALS_DB_ID },
        properties,
      },
    });
    pageId = created.id;
  }

  if (input.brief) await appendBriefBlocks(pageId, input.brief, env);
  return pageId;
}

async function appendBriefBlocks(pageId: string, brief: string, env: Env): Promise<void> {
  await notionFetch(env, `/blocks/${pageId}/children`, {
    method: "PATCH",
    body: { children: [heading("Pre-Call Brief", 2), ...splitParagraphs(brief)] },
  });
}

export async function getDealById(dealId: string, env: Env): Promise<Deal | null> {
  // Fetch the Deals page — returns null on 404, throws on other errors.
  let page: any;
  try {
    page = await notionFetch(env, `/pages/${dealId}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("notion_404_")) return null;
    throw err;
  }

  const props = page.properties as Record<string, any>;

  const inviteeEmail: string = props["Invitee Email"]?.email ?? "";
  const inviteeName: string = props["Invitee Name"]?.rich_text?.[0]?.plain_text ?? "";
  const eventStartsAt: string = props["Event Starts At"]?.date?.start ?? "";
  const eventUri: string = props["Event URI"]?.url ?? "";
  const status: Deal["status"] = (props["Status"]?.select?.name ?? "Booked") as Deal["status"];

  // Deal page body: pre-call brief lives in child blocks appended by upsertDeal.
  let brief: string | undefined;
  try {
    const dealBlocks = await notionFetch(env, `/blocks/${dealId}/children?page_size=100`);
    const paragraphs: string[] = [];
    let inBrief = false;
    for (const block of dealBlocks.results ?? []) {
      if (block.type === "heading_2") {
        const text: string = (block.heading_2?.rich_text ?? [])
          .map((rt: any) => rt.plain_text ?? "")
          .join("");
        inBrief = /pre-call brief/i.test(text);
        continue;
      }
      if (inBrief && block.type === "paragraph") {
        const text: string = (block.paragraph?.rich_text ?? [])
          .map((rt: any) => rt.plain_text ?? "")
          .join("");
        if (text) paragraphs.push(text);
      }
    }
    if (paragraphs.length > 0) brief = paragraphs.join("\n\n");
  } catch {
    // Brief lookup is best-effort.
  }

  // Transcripts DB: query for rows whose Deal relation points to this page.
  let transcript: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  try {
    const transcriptQuery = await notionFetch(
      env,
      `/databases/${env.NOTION_TRANSCRIPTS_DB_ID}/query`,
      {
        method: "POST",
        body: {
          filter: { property: "Deal", relation: { contains: dealId } },
          sorts: [{ property: "Started At", direction: "descending" }],
          page_size: 1,
        },
      },
    );

    const transcriptPage = transcriptQuery.results?.[0];
    if (transcriptPage) {
      const tProps = transcriptPage.properties as Record<string, any>;
      startedAt = tProps["Started At"]?.date?.start ?? undefined;
      endedAt = tProps["Started At"]?.date?.end ?? undefined;

      // Transcript body lives in the page's child blocks (written by saveTranscript).
      const blocks = await notionFetch(
        env,
        `/blocks/${transcriptPage.id}/children?page_size=100`,
      );

      const paragraphTexts: string[] = [];
      for (const block of blocks.results ?? []) {
        if (block.type === "paragraph") {
          const text: string = (block.paragraph?.rich_text ?? [])
            .map((rt: any) => rt.plain_text ?? "")
            .join("");
          if (text) paragraphTexts.push(text);
        }
      }
      if (paragraphTexts.length > 0) transcript = paragraphTexts.join("\n\n");
    }
  } catch {
    // Transcript lookup is best-effort — a missing transcript is not fatal.
  }

  return {
    id: dealId,
    inviteeEmail,
    inviteeName,
    eventStartsAt,
    eventUri,
    questionsAndAnswers: [],
    status,
    startedAt,
    endedAt,
    transcript,
    brief,
  };
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

  const res = await notionFetch(env, `/databases/${env.NOTION_DEALS_DB_ID}/query`, {
    method: "POST",
    body: {
      filter: {
        and: [
          { property: "Invitee Email", email: { equals: externalAttendee.email } },
          { property: "Event Starts At", date: { on_or_after: lower } },
          { property: "Event Starts At", date: { on_or_before: upper } },
        ],
      },
      page_size: 1,
    },
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

  await notionFetch(env, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: env.NOTION_TRANSCRIPTS_DB_ID },
      properties,
      children,
    },
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

  await notionFetch(env, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: env.NOTION_PITCH_ARTIFACTS_DB_ID },
      properties,
      children,
    },
  });

  // Flip deal status: -> Pitched
  await notionFetch(env, `/pages/${input.dealId}`, {
    method: "PATCH",
    body: { properties: { Status: { select: { name: "Pitched" } } } },
  });
}

export async function attachProposalArtifact(input: {
  dealId: string;
  pdfKey: string;
  proposalUrl?: string;
  prd: Record<string, unknown>;
  followUpEmail: string;
  internalNotes: string[];
  assumptions: string[];
  missingData: string[];
  sourceClaims: string[];
  transcriptQuoted: string[];
}, env: Env): Promise<void> {
  const prd = input.prd as any;
  const artistName = prd?.artist?.name ?? "Unknown";

  const properties: Record<string, any> = {
    Name: { title: [{ text: { content: `PRD — ${artistName} — ${new Date().toISOString().slice(0, 10)}` } }] },
    Deal: { relation: [{ id: input.dealId }] },
    "PDF Key": { rich_text: [{ text: { content: input.pdfKey } }] },
    Status: { select: { name: "Draft" } },
  };

  const children: any[] = [
    heading("Proposal PRD", 2),

    ...(input.proposalUrl ? splitParagraphs(`**Live proposal:** ${input.proposalUrl}`) : []),

    heading("Artist", 3),
    ...splitParagraphs(
      `**${artistName}** — ${prd?.artist?.genre ?? "genre TBD"}\n\n` +
      `Spotify: ${prd?.artist?.spotifyUrl ?? "not provided"}\n` +
      `Monthly listeners: ${prd?.artist?.monthlyListeners ?? "unknown"}\n` +
      `Label: ${prd?.artist?.label ?? "unknown"} | Management: ${prd?.artist?.management ?? "unknown"}`
    ),

    heading("Headline", 3),
    ...splitParagraphs(`${prd?.headline ?? ""}\n\n${prd?.subheadline ?? ""}`),

    heading("Why Now", 3),
    ...splitParagraphs(prd?.whyNow ?? "Not specified"),

    heading("Campaign Strategy", 3),
    ...splitParagraphs(
      `Platforms: ${prd?.campaignStrategy?.platforms?.join(", ") ?? "TBD"}\n\n` +
      `Approach: ${prd?.campaignStrategy?.approach ?? "TBD"}\n\n` +
      `Creator types: ${prd?.campaignStrategy?.creatorTypes?.join(", ") ?? "TBD"}\n\n` +
      `Content formats: ${prd?.campaignStrategy?.contentFormats?.join(", ") ?? "TBD"}`
    ),

    heading("Budget Options", 3),
    ...((prd?.budgetOptions ?? []) as any[]).map((opt: any) =>
      bullet(`${opt.name}: ${opt.amount} — ${opt.scope} (${opt.creatorCount})`)
    ),

    heading("Creator Roster Requirements", 3),
    ...splitParagraphs(
      `Target: ${prd?.creatorRoster?.targetCount ?? "TBD"}\n\n` +
      `Niches: ${prd?.creatorRoster?.niches?.join(", ") ?? "TBD"}\n\n` +
      `Specific names: ${prd?.creatorRoster?.specificNames?.length ? prd.creatorRoster.specificNames.join(", ") : "none mentioned"}\n\n` +
      `Reach target: ${prd?.creatorRoster?.combinedReachTarget ?? "TBD"}`
    ),

    heading("Timeline", 3),
    ...splitParagraphs(
      `Release date: ${prd?.timeline?.releaseDate ?? "TBD"}\n\n` +
      `Campaign window: ${prd?.timeline?.campaignWindow ?? "TBD"}`
    ),
    ...(prd?.timeline?.milestones ?? []).map((m: string) => bullet(m)),

    heading("Before Launch (prospect must provide)", 3),
    ...(prd?.beforeLaunch ?? []).map((item: string) => bullet(item)),

    heading("Proof Points", 3),
    ...(prd?.proofPoints ?? []).map((p: string) => bullet(p)),

    heading("PRD JSON (machine-readable)", 3),
    ...codeBlocks(JSON.stringify(input.prd, null, 2), "json"),

    heading("Follow-Up Email Draft", 3),
    ...splitParagraphs(input.followUpEmail),

    heading("Internal Notes", 3),
    ...(input.internalNotes.length ? input.internalNotes.map(bullet) : [bullet("None")]),

    heading("Assumptions", 3),
    ...(input.assumptions.length ? input.assumptions.map(bullet) : [bullet("None")]),

    heading("Missing Data", 3),
    ...(input.missingData.length ? input.missingData.map(bullet) : [bullet("None")]),

    heading("Source Claims", 3),
    ...(input.sourceClaims.length ? input.sourceClaims.map(bullet) : [bullet("None")]),

    heading("Transcript Lines Quoted", 3),
    ...input.transcriptQuoted.map((q: string) => bullet(`"${q}"`)),
  ];

  await notionFetch(env, "/pages", {
    method: "POST",
    body: {
      parent: { database_id: env.NOTION_PITCH_ARTIFACTS_DB_ID },
      properties,
      children,
    },
  });

  await notionFetch(env, `/pages/${input.dealId}`, {
    method: "PATCH",
    body: { properties: { Status: { select: { name: "Pitched" } } } },
  });
}

/**
 * Claude client — uses raw fetch (the @anthropic-ai/sdk Node client isn't
 * Workers-compatible out of the box).
 *
 * Model strategy (per RT CLAUDE.md):
 *   - Sonnet 4.6 for the pre-call brief (fast, cheap, good enough)
 *   - Opus 4.5 with extended thinking for the post-call pitch (deep reasoning)
 */

import type { Env } from "./env";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const MODEL_BRIEF = "claude-sonnet-4-5-20250929";  // alias to current Sonnet 4.6
const MODEL_PITCH = "claude-opus-4-5-20250929";    // alias to current Opus 4.5

interface MessagesRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  thinking?: { type: "enabled"; budget_tokens: number };
}

interface MessagesResponse {
  id: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

async function callClaude(body: MessagesRequest, env: Env): Promise<MessagesResponse> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`anthropic_${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json() as Promise<MessagesResponse>;
}

function extractText(res: MessagesResponse): string {
  const textBlock = res.content.find((b) => b.type === "text" && b.text);
  return textBlock?.text ?? "";
}

// ---------- Pre-call brief ----------
export async function composeBrief(input: {
  invitee: {
    inviteeEmail: string;
    inviteeName: string;
    eventStartsAt: string;
    questionsAndAnswers: Array<{ question: string; answer: string }>;
  };
  enrichment: unknown;
}, env: Env): Promise<string> {
  const res = await callClaude({
    model: MODEL_BRIEF,
    max_tokens: 2048,
    system: PRE_CALL_BRIEF_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Invitee + enrichment data:\n\n${JSON.stringify(input, null, 2)}`,
      },
    ],
  }, env);
  return extractText(res);
}

const PRE_CALL_BRIEF_SYSTEM = `You are Eric Cromartie's sales strategist at Rising Tides, a music industry social media marketing agency. Eric reads this brief 30 seconds before a sales call. Write like a sharp co-founder, not a data analyst.

## Brief structure (prose, no preamble):

**THE ARTIST** — One paragraph. Name, label, genre, where they sit in the market. If they're indie vs major-label, that changes the entire conversation. Use Songstats data as the primary source.

**THE NUMBERS** — A tight stat block, not a wall of text:
- Monthly listeners / Popularity score (0-100) / Followers / Total streams
- Playlist placements (current total + editorial count)
- Social: IG, TikTok, YouTube followers
- Top 3 tracks as a table: track name | popularity score | total streams
  Popularity score is the money metric — it shows which songs have momentum RIGHT NOW. 70+ = hot, push it as a TikTok sound. High streams but low popularity = sleeping catalog track that could be re-activated with the right campaign. This is how Eric sells budget allocation on the call.

If any data returned null or zero, say "data unavailable" and move on. Don't speculate why. Zero followers on a known artist = API issue, not reality.

**PRIOR RELATIONSHIP** — Check TWO sources:
1. enrichment.crm — this is the Rising Tides CRM (Notion). exactMatches = campaigns featuring THIS artist. labelMatches = campaigns with the same label or related artists. For each match, mention: artist name, song, campaign stage, media spend, and label.
2. enrichment.gmail — email thread history with the prospect's address.
If CRM has matches, this is NOT a cold lead — reference the specific campaigns. If CRM has label matches, mention RT's relationship with that label. Only say "Cold — first contact" if both CRM and Gmail are empty.

**THE PLAY** — This is the most important section. One paragraph, Eric's voice. What should Rising Tides pitch this artist? Be specific to their tier:
- Under 100K listeners: discovery + audience building. Prove RT can move the needle.
- 100K-1M: growth acceleration. Content testing + playlist strategy.
- 1M-10M: scale. Creator campaigns, TikTok seeding, release amplification.
- 10M+: precision. They don't need awareness — they need cultural moments and campaign speed their label can't deliver internally.
If the CRM shows past campaigns with this artist or label, USE THEM as proof points. Reference actual song names, spend levels, and campaign stages. This is the single strongest selling tool on the call.

**THREE QUESTIONS** — Specific, strategic, designed to qualify the deal and surface blockers. Not generic. Each question should reveal something that changes how RT would scope the campaign.

## Rules:
- Only use data present in the enrichment payload. Never invent stats, clients, or history.
- Write with confidence. If data exists, state it. If it doesn't, skip it — don't hedge for three sentences about what might be wrong.
- Eric's tone: direct, music-industry fluent, founder energy. No marketing jargon. No "leverage synergies." Talk like someone who's been in the room.
`;

// ---------- Post-call pitch ----------
export interface PitchOutput {
  deckHtml: string;
  emailDraft: string;
  actionItems: string[];
  quotedTranscriptLines: string[];
}

export async function composePitch(input: {
  deal: { id: string };
  transcript: string;
  summary?: string;
}, env: Env): Promise<PitchOutput> {
  const res = await callClaude({
    model: MODEL_PITCH,
    max_tokens: 8192,
    thinking: { type: "enabled", budget_tokens: 8000 },
    system: POST_CALL_PITCH_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Deal ID: ${input.deal.id}\n\nTranscript:\n${input.transcript}\n\nSummary:\n${input.summary ?? "(none)"}`,
      },
    ],
  }, env);

  const text = extractText(res);
  const parsed = extractJson<PitchOutput>(text);
  if (!parsed) throw new Error("pitch_compose_unparseable");
  if (!parsed.quotedTranscriptLines || parsed.quotedTranscriptLines.length < 3) {
    throw new Error("pitch_must_quote_three_lines");
  }
  return parsed;
}

const POST_CALL_PITCH_SYSTEM = `You are Rising Tides' post-call pitch composer.

You will be given a sales call transcript. Produce a JSON object with this exact shape:

{
  "deckHtml": "...",
  "emailDraft": "...",
  "actionItems": ["...", "..."],
  "quotedTranscriptLines": ["...", "...", "..."]
}

Hard rules:
- The email body must quote at least 3 specific things the prospect said.
- Never invent numbers, deals, or quotes.
- Output ONLY the JSON object, no preamble, no code fence.
`;

function extractJson<T>(text: string): T | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}

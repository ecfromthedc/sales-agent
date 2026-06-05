/**
 * Claude client — uses raw fetch (the @anthropic-ai/sdk Node client isn't
 * Workers-compatible out of the box).
 *
 * Model strategy (per RT CLAUDE.md):
 *   - Sonnet 4.6 for the pre-call brief (fast, cheap, good enough)
 *   - Opus 4.5 with extended thinking for the post-call pitch (deep reasoning)
 */

import type { Env } from "./env";
import {
  type FilledPitchSection,
  orderSections,
  sectionsPromptBlock,
} from "./pitch-sections";

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

const PRE_CALL_BRIEF_SYSTEM = `You write pre-call briefs for Eric Cromartie, founder of Rising Tides (music marketing agency). He reads these 30 seconds before a sales call.

## Voice rules — non-negotiable:
- Inverted pyramid. Most important info first. Every sentence.
- Short sentences. 1-2 lines max per point. Eric skims, he doesn't read essays.
- State facts. Skip hedging. If data is missing, just don't mention it. Move on.
- No AI slop: no "this is not just X — it's Y", no "paradigm", no "landscape", no "leverage", no "synergies", no "game-changer", no "deep dive." Write like a person in the music industry, not a LinkedIn post.
- Numbers go in the first sentence they're relevant. "70M monthly listeners" not "an impressive streaming presence."
- Never invent stats, clients, campaigns, or history. Only reference data in the enrichment payload.

## Brief structure:

**ARTIST** — Name, label, genre, monthly listeners, popularity score. One line on where they sit in the market. Done.

**NUMBERS** — Stat block, not prose:
- Listeners / Popularity / Followers / Streams
- Playlists (current + editorial)
- Social: IG, TikTok, YouTube
- Top 3 tracks: name | popularity | streams. Popularity 70+ = hot, push as TikTok sound. High streams + low popularity = catalog re-activation play.

**RT HISTORY** — Check enrichment.crm first (exactMatches = this artist, labelMatches = same label or related artists). For each hit: artist, song, stage, spend, label. Then check enrichment.gmail for email threads. If CRM has matches, lead with them — "RT ran X campaign for $Y" is the strongest thing Eric can say on the call. Only say "Cold" if both are empty.

**COMPARABLE CLIENTS** — Check enrichment.comparables (RT past clients pre-ranked most-similar-first by genre, audience tier, and recency). If non-empty, list the top 1-3: artist name + why they're comparable (same genre, similar audience size, or recent). These are real RT campaigns Eric can name-drop as proof — "we did this for [comparable artist], same lane as you." Only use names that appear in enrichment.comparables. If empty, skip this section entirely — don't invent comparables.

**THE PLAY** — What Eric should pitch. One paragraph max. Match the tier:
- Under 100K: prove RT moves the needle. Audience building.
- 100K-1M: growth. Content testing + playlist strategy.
- 1M-10M: scale. Creator campaigns, TikTok seeding.
- 10M+: speed and precision. They have reach, they need cultural timing.
If CRM has past campaigns, reference the specific songs and spend as proof. That's Eric's closer.

**THREE QUESTIONS** — Each one should surface a deal-shaping answer. Not "what are your goals" — that's waste. Ask about: release timeline, approval process speed, who controls budget, what's already running internally.
`;

// ---------- Post-call pitch ----------
export interface PitchOutput {
  deckHtml: string;
  emailDraft: string;
  actionItems: string[];
  quotedTranscriptLines: string[];
  /** Canonical, ordered deck sections (see lib/pitch-sections.ts). Always the
   *  full set in template order; missing sections come back with an empty body. */
  sections: FilledPitchSection[];
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
  // Normalize the model's sections into the canonical order. Always returns the
  // full ordered set (missing sections come back empty) so every deck is
  // structurally consistent regardless of what the model emitted.
  parsed.sections = orderSections((parsed as { sections?: unknown }).sections);
  return parsed;
}

const POST_CALL_PITCH_SYSTEM = `You are Rising Tides' post-call pitch composer.

You will be given a sales call transcript. Produce a JSON object with this exact shape:

{
  "deckHtml": "...",
  "emailDraft": "...",
  "actionItems": ["...", "..."],
  "quotedTranscriptLines": ["...", "...", "..."],
  "sections": [{ "id": "...", "title": "...", "body": "..." }]
}

The deck must follow this exact section structure, in this order. Fill every
section as one entry in "sections" using the given "id", and build "deckHtml"
from the same sections in the same order:

${sectionsPromptBlock()}

Hard rules:
- "sections" must contain one entry per id above, in order, each with a non-empty "body".
- "deckHtml" must render those same sections in the same order (Swiss-grid layout).
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

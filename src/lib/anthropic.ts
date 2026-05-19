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

const PRE_CALL_BRIEF_SYSTEM = `You are Rising Tides' pre-call brief writer.
Eric Cromartie reads these 30 seconds before joining a sales call.

Output a single-page brief in plain prose with these sections, no preamble:

1. Who they are (one paragraph — artist, label/management if known, what they make, current trajectory)
2. Past RT touchpoints (Gmail, Tides Tracker, Notion CRM evidence — quote dates and subjects if any; if none, say "cold lead, no prior touchpoint")
3. Platform snapshot — use Songstats data (enrichment.songstats) as the PRIMARY source for stats. Include:
   - Monthly listeners (songstats.spotify.monthlyListeners)
   - Popularity score (songstats.spotify.popularity)
   - Followers (songstats.spotify.followers)
   - Total streams (songstats.spotify.streamsTotal)
   - Playlist placements (songstats.spotify.playlistsCurrent, editorial count)
   - Social following (songstats.social — Instagram, TikTok, YouTube if available)
   - Genres (songstats.genres)
   - Related artists (songstats.relatedArtists)
   Fall back to enrichment.spotify only for release catalog (recentReleases, topTracks) since Spotify's public API still returns those.
4. Comparable RT clients (look at past campaigns in the enrichment data — find clients with similar genre, audience size, goals, or release timeline. Name 1-3 past clients whose results Eric can reference as proof points on the call. If no past campaigns match, say "no close comparables in campaign history.")
5. Suggested angle (one paragraph, written in Eric's voice — direct, music-industry-specific, no generic marketing speak. Weave in the comparable client results if available.)
6. Three questions Eric should ask on the call

Hard rules:
- Never invent metrics. If Spotify enrichment is missing, say so explicitly.
- If followers = 0 or popularity = 0, the API likely failed or returned bad data. Say "Spotify data unavailable — verify manually" instead of interpreting zero as a real number.
- Monthly listeners are NOT available from the Spotify API. Never state a monthly listener count unless the prospect provided it in their intake form notes. If they self-reported it, caveat with "(self-reported, unverified)."
- Never invent past touchpoints. If Gmail returned zero threads, say "cold."
- Never invent case studies or client names. Only reference clients present in the pastCampaigns enrichment data.
- If pastCampaigns.count is 0, the tracker returned no data — don't speculate about why.
- Distinguish between "we checked and found nothing" vs "the data source was unavailable." Check the enrichment.failures array for which sources errored.
- Match Eric's tone: concise, founder-direct, no fluff.
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

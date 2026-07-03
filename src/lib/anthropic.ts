/**
 * Claude client — uses raw fetch (the @anthropic-ai/sdk Node client isn't
 * Workers-compatible out of the box).
 *
 * Model strategy (per RT CLAUDE.md):
 *   - Sonnet 4.6 for the pre-call brief (fast, cheap, good enough)
 *   - Opus 4.8 with adaptive thinking for the post-call pitch/proposal
 *     (budget_tokens is removed on Opus 4.7+ — adaptive is the only on-mode)
 */

import {
  type FilledPitchSection,
  orderSections,
  sectionsPromptBlock,
} from "./pitch-sections";

/**
 * Minimal structural env for {@link callClaude}. Narrowed from the concrete
 * sales `Env` (SALE-129) so shared primitives don't transitively drag in the
 * full Worker env (and its `@cloudflare/puppeteer` types). The sales `Env` is a
 * structural superset, so every existing caller still satisfies this.
 */
export interface AnthropicEnv {
  ANTHROPIC_API_KEY: string;
}

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const MODEL_BRIEF = "claude-sonnet-4-6";
const MODEL_PITCH = "claude-opus-4-8";

export interface MessagesResponse {
  id: string;
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

/**
 * Options for {@link callClaude} — the shared Anthropic Messages-API primitive.
 * Every compose function routes through here so the raw HTTP call (endpoint,
 * headers, anthropic-version, request body) lives in exactly one place.
 */
export interface CallClaudeOptions {
  model: string;
  maxTokens: number;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  system?: string;
  thinking?: { type: "adaptive" };
}

/**
 * Single shared core that performs the raw Anthropic Messages `fetch`. Workers-
 * compatible (raw fetch, no SDK). Throws on non-2xx; otherwise returns the
 * parsed Messages response.
 */
export async function callClaude(
  env: AnthropicEnv,
  { model, maxTokens, messages, system, thinking }: CallClaudeOptions,
): Promise<MessagesResponse> {
  const body: {
    model: string;
    max_tokens: number;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    system?: string;
    thinking?: { type: "adaptive" };
  } = { model, max_tokens: maxTokens, messages };
  if (system !== undefined) body.system = system;
  if (thinking !== undefined) body.thinking = thinking;

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

/** Result of a web-search-grounded research call. */
export interface WebResearchResult {
  /** Concatenated final answer text. */
  text: string;
  /** De-duplicated source citations surfaced during the search. */
  citations: Array<{ title: string; url: string }>;
}

// Anthropic server-side web search tool (stable version — no code-execution
// dependency, so it runs fine in a Worker). The server runs the search loop and
// may return `pause_turn`; we re-request with the assistant turn appended until
// it finishes (bounded so a misbehaving loop can't run forever).
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const WEB_SEARCH_MAX_TURNS = 5;

/**
 * Run a web-search-grounded research prompt and return the final text plus
 * citations. Uses the brief model (fast/cheap). Best-effort: throws on a non-2xx
 * HTTP response so the caller can swallow it — enrichment must never block a brief.
 */
export async function researchWithWebSearch(
  env: AnthropicEnv,
  params: { prompt: string; system: string; maxUses?: number },
): Promise<WebResearchResult> {
  type Block = { type: string; text?: string; citations?: Array<Record<string, unknown>> };
  const messages: Array<{ role: "user" | "assistant"; content: string | Block[] }> = [
    { role: "user", content: params.prompt },
  ];
  const tools = [
    { type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: params.maxUses ?? 5 },
  ];

  let final: { content: Block[]; stop_reason: string } | null = null;
  for (let turn = 0; turn < WEB_SEARCH_MAX_TURNS; turn++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL_BRIEF,
        max_tokens: 1500,
        system: params.system,
        tools,
        messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic_web_search_${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    final = (await res.json()) as { content: Block[]; stop_reason: string };
    // `pause_turn` means the server paused mid-search — resume by echoing the
    // assistant turn back and re-requesting. Any other stop reason is terminal.
    if (final.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: final.content });
  }

  const blocks = final?.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text as string)
    .join("")
    .trim();

  const citations = new Map<string, { title: string; url: string }>();
  for (const b of blocks) {
    for (const c of b.citations ?? []) {
      const url = typeof c.url === "string" ? c.url : null;
      if (url && !citations.has(url)) {
        citations.set(url, { url, title: typeof c.title === "string" ? c.title : url });
      }
    }
  }

  return { text, citations: [...citations.values()] };
}

/**
 * Pull the first text block out of a Claude Messages response. Returns the empty
 * string when the response carries no text block (e.g. thinking-only or empty
 * content). Single source of truth for Claude text extraction across all roles —
 * callers that want trimmed output should `.trim()` at the call site.
 */
export function extractText(res: MessagesResponse): string {
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
}, env: AnthropicEnv): Promise<string> {
  const res = await callClaude(env, {
    model: MODEL_BRIEF,
    maxTokens: 2048,
    system: PRE_CALL_BRIEF_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Invitee + enrichment data:\n\n${JSON.stringify(input, null, 2)}`,
      },
    ],
  });
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
- For popularity, prefer enrichment.chartmetric.cmScore (0–100 cross-platform Chartmetric score) and cmRank (global rank) when present — "Chartmetric 82, ranked #1,400 globally" is the sharpest read on momentum. Fall back to enrichment.songstats Spotify popularity if Chartmetric is missing.

**WHO THEY ARE** — Always include this, from enrichment.web (always-on web research on the booker, their act, and the company behind their email). 2-4 tight lines: who booked the call (artist, manager, or label/company rep), who/what they're connected to, and anything that shapes the pitch. This is the picture for cold prospects where Spotify/Chartmetric are empty — lean on it. If enrichment.web is null or says nothing was found, write "Couldn't confirm much online" and move on. Never invent — only use what enrichment.web states.

**NUMBERS** — Stat block, not prose:
- Chartmetric score (0–100) + global rank, if present
- Listeners / Popularity / Followers / Streams
- Playlists (current + editorial)
- Social: IG, TikTok, YouTube
- Top songs: from enrichment.chartmetric.topTracks (up to 5) — name | Spotify popularity. List highest-popularity first. Popularity 70+ = hot, push as a TikTok sound. High streams + low popularity = catalog re-activation play.
- Latest releases: from enrichment.chartmetric.latestTracks (up to 3) — name | release date | Spotify popularity. This is the momentum read: are their newest drops landing (high popularity) or under-performing (a gap we can fix)? Call out the contrast vs. their top songs if it's stark.

**LINKS** — clickable profile URLs for quick assessment. Pull from enrichment.songstats.platformLinks and the Spotify link from the Calendly Q&A. Format as a compact list:
- Spotify: [url]
- Instagram: [url]
- TikTok: [url]
- YouTube: [url]
- (any other platforms in platformLinks)
Only include platforms where a URL exists in the enrichment data. Skip platforms with no URL — don't guess or construct URLs.

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

export interface ProposalOutput {
  prd: {
    artist: {
      name: string;
      spotifyUrl: string | null;
      imageUrl: string | null;
      genre: string;
      monthlyListeners: string | null;
      label: string | null;
      management: string | null;
    };
    headline: string;
    subheadline: string;
    whyNow: string;
    campaignStrategy: {
      platforms: string[];
      approach: string;
      creatorTypes: string[];
      contentFormats: string[];
    };
    budgetOptions: Array<{
      name: string;
      amount: string;
      scope: string;
      creatorCount: string;
    }>;
    creatorRoster: {
      targetCount: string;
      niches: string[];
      specificNames: string[];
      combinedReachTarget: string | null;
    };
    timeline: {
      releaseDate: string | null;
      campaignWindow: string | null;
      milestones: string[];
    };
    beforeLaunch: string[];
    proofPoints: string[];
  };
  followUpEmail: string;
  internalNotes: string[];
  assumptions: string[];
  missingData: string[];
  sourceClaims: string[];
  quotedTranscriptLines: string[];
}

export async function composePitch(input: {
  deal: { id: string };
  transcript: string;
  summary?: string;
}, env: AnthropicEnv): Promise<PitchOutput> {
  const res = await callClaude(env, {
    model: MODEL_PITCH,
    // Adaptive thinking spends inside max_tokens — headroom for thinking + output.
    maxTokens: 16000,
    thinking: { type: "adaptive" },
    system: POST_CALL_PITCH_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Deal ID: ${input.deal.id}\n\nTranscript:\n${input.transcript}\n\nSummary:\n${input.summary ?? "(none)"}`,
      },
    ],
  });

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

// ---------- Proposal draft ----------
export async function composeProposal(input: {
  deal: {
    id: string;
    inviteeEmail: string;
    inviteeName: string;
    eventStartsAt: string;
    eventUri: string;
    status: string;
  };
  transcript: string;
  preCallBrief?: string;
  priorPitch?: PitchOutput;
  // Refine mode: revise an existing proposal per Eric's Slack instruction.
  priorProposal?: ProposalOutput;
  refinement?: string;
}, env: AnthropicEnv): Promise<ProposalOutput> {
  const refineBlock = input.refinement
    ? `\n\n--- REFINEMENT REQUEST ---\nEric reviewed the proposal below and wants this change:\n"${input.refinement}"\n\nReturn the FULL updated JSON object. Apply the requested change. Keep everything else intact unless the change requires otherwise. Still honor every evidence rule — never fabricate to satisfy the edit; if the edit asks for data you don't have, put it in missingData.\n\nCurrent proposal JSON:\n${JSON.stringify(input.priorProposal ?? {}, null, 2)}`
    : "";

  const res = await callClaude(env, {
    model: MODEL_PITCH,
    // Adaptive thinking spends inside max_tokens — headroom for thinking + output.
    maxTokens: 16000,
    thinking: { type: "adaptive" },
    system: PROPOSAL_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Deal:\n${JSON.stringify(input.deal, null, 2)}\n\nPre-call brief, if available:\n${input.preCallBrief ?? "(none)"}\n\nTranscript:\n${input.transcript}\n\nPrior pitch output, if any:\n${input.priorPitch ? JSON.stringify(input.priorPitch, null, 2) : "(none)"}${refineBlock}`,
      },
    ],
  });

  const text = extractText(res);
  const parsed = extractJson<ProposalOutput>(text);
  if (!parsed) throw new Error("proposal_compose_unparseable");
  if (!parsed.prd?.artist?.name || !parsed.prd?.headline || !parsed.followUpEmail) {
    throw new Error("proposal_missing_required_fields");
  }
  if (!parsed.quotedTranscriptLines || parsed.quotedTranscriptLines.length < 3) {
    throw new Error("proposal_must_quote_three_lines");
  }
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

const PROPOSAL_SYSTEM = `You are Rising Tides' PRD composer. You do NOT build the proposal itself. You build the structured brief that feeds the proposals agent — a separate system that owns the brand kit, design system, and HTML rendering.

Your job: extract every decision-relevant detail from the call transcript and enrichment data, then package it into a clean PRD that the proposals agent can execute against without needing any additional context.

Think of this like a creative brief for a designer. The proposals agent will use your PRD to build a premium, Shaboozey-quality pitch deck with the RT brand system (Swiss Grid, dark editorial, curated creator roster cards, budget tier panels). If your PRD is vague, the proposal will be generic. If your PRD is specific, the proposal will close deals.

Return ONLY valid JSON matching this exact shape:

{
  "prd": {
    "artist": {
      "name": "Artist Name",
      "spotifyUrl": "https://open.spotify.com/artist/...",
      "imageUrl": null,
      "genre": "country / pop / hip-hop / etc",
      "monthlyListeners": "800K" or null,
      "label": "Label Name" or null,
      "management": "Manager Name / Company" or null
    },
    "headline": "One punchy line that frames the proposal angle. E.g. 'Plant Cowgirl in country culture.' or 'Make Gemini the summer anthem.' This becomes the hero text.",
    "subheadline": "One sentence expanding on the headline — the editorial thesis.",
    "whyNow": "Why this campaign, this song, this moment. Reference specific timing from the call (release date, TikTok momentum, cultural window).",
    "campaignStrategy": {
      "platforms": ["TikTok", "Instagram"],
      "approach": "What the campaign actually does — UGC seeding, sound campaigns, creator placements, content strategy coaching, etc. Be specific to what was discussed.",
      "creatorTypes": ["face creators", "theme pages", "country-lifestyle", etc],
      "contentFormats": ["performance", "transition", "digital postcard", etc]
    },
    "budgetOptions": [
      {
        "name": "Focused Seed",
        "amount": "$5,000",
        "scope": "What this buys — creator count, post count, expected impressions",
        "creatorCount": "50-80 posts"
      }
    ],
    "creatorRoster": {
      "targetCount": "50-80 creators",
      "niches": ["country-lifestyle", "truck-talk", "coffee-morning"],
      "specificNames": ["any creators mentioned on the call"],
      "combinedReachTarget": "2M+ impressions" or null
    },
    "timeline": {
      "releaseDate": "2026-07-15" or null,
      "campaignWindow": "2 weeks post-release" or null,
      "milestones": ["Send songs for review", "Finalize budget", "Campaign launch day-of-release"]
    },
    "beforeLaunch": [
      "Audio link / approved snippets",
      "Confirmed release date",
      "Platform split decision (TikTok-only or TikTok + IG)",
      "Approval window for creator selection"
    ],
    "proofPoints": [
      "Specific reasons RT is the right fit for this prospect — reference past work, shared connections, genre expertise. Only use facts from the enrichment or transcript."
    ]
  },
  "followUpEmail": "Draft email in Eric's voice...",
  "internalNotes": ["Things Eric should know but don't go in the proposal"],
  "assumptions": ["Things you're assuming because they weren't explicitly stated"],
  "missingData": ["Critical info that wasn't discussed — the proposals agent needs to know what's missing so it doesn't fabricate"],
  "sourceClaims": ["Every number, name, or fact with where it came from: 'monthly listeners 800K — from enrichment.spotify' or 'budget $5K — prospect stated at 24:19'"],
  "quotedTranscriptLines": ["Exact quotes from the transcript — at least 3"]
}

PRD rules:
- Every field in prd.* must be filled from the transcript or enrichment data. If unknown, use null — never guess.
- budgetOptions must reflect what was actually discussed on the call. If no budget was discussed, use a single option with the amount from assumptions and flag it in assumptions[].
- beforeLaunch items should be specific to this deal, not generic checklists.
- proofPoints are for the proposals agent to use as credibility markers — past RT clients in similar genres, shared connections, specific expertise.
- headline should be 3-8 words, punchy, specific to this artist/song. NOT "Rising Tides Proposal for [Artist]."

Evidence rules:
- Quote at least 3 exact lines from the transcript in quotedTranscriptLines.
- Every numerical claim must appear in sourceClaims with provenance.
- Never invent metrics, case studies, budgets, timelines, names, or quotes.
- If data is missing, say what's missing in missingData. The proposals agent will mark it as TBD rather than fabricate.

followUpEmail voice (Eric Cromartie):
- Short, warm, direct. "Hey [First Name]," opening.
- Reference something specific from the call — a song, a goal, a moment.
- 2-5 sentences. Mention that the proposal is attached/linked.
- No corporate language: no landscape, leverage, synergize, game-changer, elevate, ecosystem.
- This is a draft for Eric to review, not auto-sent.
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

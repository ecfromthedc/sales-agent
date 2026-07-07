// Cross-Worker dedup (SALE-131): the raw Anthropic Messages `fetch` now lives in
// exactly one place — the shared `callClaude` primitive (Env-decoupled in
// SALE-129, takes a minimal `AnthropicEnv { ANTHROPIC_API_KEY }`). Henry's `Env`
// is a structural superset, so callers pass `env` unchanged. This local
// `callAnthropic` is a thin adapter that preserves Henry's exact prior behavior:
// single Sonnet call, max_tokens 4096, one system + one user message, returns
// the extracted text block (or '').
import { callClaude } from '../../../src/lib/anthropic';
import type { Env } from './env';
import type { Artist, Label, LeadScore, OutreachDraft, OutreachSignal } from './types';

const SONNET = 'claude-sonnet-4-6';

async function callAnthropic(
  env: Env,
  model: string,
  system: string,
  userMessage: string,
): Promise<string> {
  const res = await callClaude(env, {
    model,
    maxTokens: 4096,
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  const textBlock = res.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

const SCORE_SYSTEM = `You are a lead scoring agent for Rising Tides, a music industry social media marketing agency.

Score this lead on a 0-100 scale based on:
- Genre fit (do we have proven results in this genre?)
- Tier fit (is this artist in our sweet spot: 10K-500K monthly listeners?)
- Timing (is there an upcoming release or promo window?)
- Relationship proximity (have we worked with this label, A&R, or related artists?)
- Recency (how fresh is this opportunity?)

Return ONLY valid JSON matching this schema:
{
  "total": number,
  "breakdown": { "genreFit": number, "tierFit": number, "timing": number, "relationshipProximity": number, "recency": number },
  "reasoning": "string"
}`;

export async function scoreLeads(
  env: Env,
  artist: Artist,
  label: Label,
  signals: OutreachSignal[],
  crmContext: string,
): Promise<LeadScore> {
  const userMessage = `Artist: ${artist.name}
Label: ${label.name}
Monthly Listeners: ${artist.monthlyListeners ?? 'unknown'}
Genres: ${artist.genres.join(', ')}
Tier: ${artist.tier}
Label Relationship: ${label.relationship}
Signals: ${JSON.stringify(signals)}
CRM Context: ${crmContext}`;

  const result = await callAnthropic(env, SONNET, SCORE_SYSTEM, userMessage);
  return JSON.parse(result) as LeadScore;
}

const DRAFT_SYSTEM = `You are an outreach email drafter for Rising Tides, a music industry social media marketing agency run by Eric Cromartie.

Write a personalized, concise outreach email that:
- References real shared history or connections (if any)
- Mentions specific timing signals (upcoming releases, recent drops)
- Offers specific value (not generic "we can help")
- Is confident but not pushy — peer-to-peer tone
- Is short (under 150 words body)
- Never invents metrics, case studies, or results not provided in context

Return ONLY valid JSON:
{
  "subject": "string",
  "body": "string",
  "contextUsed": ["list of context points referenced"]
}`;

export async function composeOutreach(
  env: Env,
  artist: Artist,
  label: Label,
  signals: OutreachSignal[],
  enrichment: {
    gmailHistory: string[];
    crmNotes: string[];
    recentReleases: string[];
  },
  recipientName: string,
  recipientEmail: string,
): Promise<OutreachDraft> {
  const userMessage = `Recipient: ${recipientName} (${recipientEmail})
Artist: ${artist.name} (${artist.monthlyListeners ?? '?'} monthly listeners)
Label: ${label.name}
Genres: ${artist.genres.join(', ')}
Our relationship with label: ${label.relationship}

Signals:
${signals.map((s) => `- ${s.type}: ${s.description} (strength: ${s.strength})`).join('\n')}

Gmail history with this contact:
${enrichment.gmailHistory.length > 0 ? enrichment.gmailHistory.join('\n') : 'No prior contact'}

CRM notes:
${enrichment.crmNotes.length > 0 ? enrichment.crmNotes.join('\n') : 'None'}

Recent releases by this artist:
${enrichment.recentReleases.length > 0 ? enrichment.recentReleases.join('\n') : 'None found'}`;

  const result = await callAnthropic(env, SONNET, DRAFT_SYSTEM, userMessage);
  const parsed = JSON.parse(result) as {
    subject: string;
    body: string;
    contextUsed: string[];
  };

  return {
    ...parsed,
    recipientEmail,
    recipientName,
    leadId: '',
  };
}

const GAP_ANALYSIS_SYSTEM = `You are a market gap analyst for Rising Tides, a music industry social media marketing agency.

Given a list of labels/artists we currently work with and a list of labels/artists in the broader market, identify:
1. Labels we work with that have artists we haven't serviced
2. Similar labels (same tier, genre) we haven't approached
3. Artists at labels we have relationships with who are about to release

Return ONLY valid JSON array of opportunities:
[{
  "artistName": "string",
  "labelName": "string",
  "gapType": "unworked_artist_at_known_label" | "similar_label" | "release_window",
  "reasoning": "string",
  "priority": "high" | "medium" | "low"
}]`;

export async function analyzeGaps(
  env: Env,
  currentClients: string,
  marketData: string,
): Promise<
  Array<{
    artistName: string;
    labelName: string;
    gapType: string;
    reasoning: string;
    priority: string;
  }>
> {
  const userMessage = `Current RT clients and relationships:\n${currentClients}\n\nMarket data (labels, rosters, recent releases):\n${marketData}`;
  const result = await callAnthropic(env, SONNET, GAP_ANALYSIS_SYSTEM, userMessage);
  return JSON.parse(result);
}

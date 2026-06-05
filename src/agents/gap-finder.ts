import type { Env } from '../lib/env';
import type { Artist, Label, OutreachSignal } from '../lib/types';
import { getTrackedLabels, getAllArtists } from '../integrations/notion';
import { searchArtistsByLabel } from '../integrations/spotify';
import { analyzeGaps } from '../lib/anthropic';

export interface GapResult {
  opportunities: GapOpportunity[];
  labelsAnalyzed: number;
  errors: string[];
}

export interface GapOpportunity {
  artistName: string;
  labelName: string;
  gapType: 'unworked_artist_at_known_label' | 'similar_label' | 'release_window';
  reasoning: string;
  priority: 'high' | 'medium' | 'low';
  signals: OutreachSignal[];
}

/**
 * Weekly analysis: compare our CRM (Notion) against Spotify market data
 * to find artists/labels we should be pitching.
 */
export async function runGapFinder(env: Env): Promise<GapResult> {
  const result: GapResult = {
    opportunities: [],
    labelsAnalyzed: 0,
    errors: [],
  };

  // Pull our current state from Notion
  const [labels, artists] = await Promise.all([getTrackedLabels(env), getAllArtists(env)]);

  result.labelsAnalyzed = labels.length;

  // Build CRM summary for AI analysis
  const crmSummary = buildCRMSummary(labels, artists);

  // For each label we have a relationship with, pull their full Spotify roster
  const marketData = await gatherMarketData(env, labels, result.errors);

  // Use AI to identify gaps
  const gaps = await analyzeGaps(env, crmSummary, marketData);

  // Convert AI output to typed opportunities
  for (const gap of gaps) {
    const signals: OutreachSignal[] = [
      {
        type: gap.gapType === 'release_window' ? 'upcoming_release' : 'gap_in_coverage',
        description: gap.reasoning,
        strength: gap.priority === 'high' ? 0.9 : gap.priority === 'medium' ? 0.6 : 0.3,
        detectedAt: new Date().toISOString(),
      },
    ];

    result.opportunities.push({
      artistName: gap.artistName,
      labelName: gap.labelName,
      gapType: gap.gapType as GapOpportunity['gapType'],
      reasoning: gap.reasoning,
      priority: gap.priority as GapOpportunity['priority'],
      signals,
    });
  }

  // Save state
  await env.STATE.put(
    'last_gap_analysis',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      opportunitiesFound: result.opportunities.length,
    }),
  );

  return result;
}

function buildCRMSummary(labels: Label[], artists: Artist[]): string {
  const labelSummary = labels
    .map((l) => `- ${l.name} (${l.relationship}): genres=${l.genres.join(',')}`)
    .join('\n');

  const artistSummary = artists
    .filter((a) => a.hasWorkedWithRT)
    .map((a) => `- ${a.name} @ ${a.labelName} (${a.tier}, ${a.monthlyListeners ?? '?'} ML)`)
    .join('\n');

  return `Labels:\n${labelSummary}\n\nArtists we've worked with:\n${artistSummary}`;
}

async function gatherMarketData(env: Env, labels: Label[], errors: string[]): Promise<string> {
  const lines: string[] = [];

  // Only check labels we have existing relationships with (most likely to convert)
  const priorityLabels = labels.filter(
    (l) => l.relationship === 'active_client' || l.relationship === 'past_client',
  );

  const checks = priorityLabels.map(async (label) => {
    try {
      const roster = await searchArtistsByLabel(env, label.spotifyLabelName);
      const summary = roster
        .slice(0, 10)
        .map((a) => `  - ${a.name} (${a.followers} followers, ${a.genres.slice(0, 3).join('/')})`)
        .join('\n');
      return `${label.name} full roster (top 10):\n${summary}`;
    } catch (e) {
      errors.push(`Market data for ${label.name}: ${e}`);
      return '';
    }
  });

  const results = await Promise.allSettled(checks);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) {
      lines.push(r.value);
    }
  }

  return lines.join('\n\n');
}

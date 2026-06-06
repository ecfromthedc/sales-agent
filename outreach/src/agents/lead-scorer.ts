import type { Env } from '../lib/env';
import type { Artist, Label, Lead, LeadScore, OutreachSignal } from '../lib/types';
import { scoreLeads } from '../lib/anthropic';
import { searchEmailsByName } from '../integrations/gmail';
import { getAllArtists, getTrackedLabels, createLead } from '../integrations/notion';

export interface ScoreResult {
  leadsScored: number;
  leadsCreated: number;
  topLeads: Array<{ name: string; score: number; reasoning: string }>;
  errors: string[];
}

/**
 * Score a batch of potential leads based on fit, timing, and relationship proximity.
 * Creates Lead entries in Notion for anything scoring above threshold.
 */
export async function runLeadScorer(
  env: Env,
  opportunities: Array<{
    artistName: string;
    labelName: string;
    signals: OutreachSignal[];
  }>,
): Promise<ScoreResult> {
  const result: ScoreResult = {
    leadsScored: 0,
    leadsCreated: 0,
    topLeads: [],
    errors: [],
  };

  const SCORE_THRESHOLD = 50; // Minimum score to create a lead

  // Load CRM context for scoring
  const [artists, labels] = await Promise.all([getAllArtists(env), getTrackedLabels(env)]);

  const crmContext = buildCRMContext(artists, labels);

  // Score each opportunity
  for (const opp of opportunities) {
    try {
      const label = labels.find((l) => l.name === opp.labelName) ?? {
        id: '',
        name: opp.labelName,
        spotifyLabelName: opp.labelName,
        contacts: [],
        relationship: 'prospect' as const,
        genres: [],
      };

      const artist: Artist = artists.find((a) => a.name === opp.artistName) ?? {
        id: '',
        name: opp.artistName,
        labelName: opp.labelName,
        tier: 'emerging',
        genres: [],
        hasWorkedWithRT: false,
      };

      const score = await scoreLeads(env, artist, label, opp.signals, crmContext);
      result.leadsScored++;

      if (score.total >= SCORE_THRESHOLD) {
        // Create lead in Notion
        const leadData: Omit<Lead, 'id' | 'notionPageId'> = {
          artist,
          label,
          score: score.total,
          signals: opp.signals,
          status: 'scored',
          createdAt: new Date().toISOString(),
        };

        await createLead(env, leadData);
        result.leadsCreated++;

        result.topLeads.push({
          name: `${artist.name} @ ${label.name}`,
          score: score.total,
          reasoning: score.reasoning,
        });
      }
    } catch (e) {
      result.errors.push(`${opp.artistName}: ${e}`);
    }
  }

  // Sort top leads by score
  result.topLeads.sort((a, b) => b.score - a.score);

  return result;
}

function buildCRMContext(artists: Artist[], labels: Label[]): string {
  const activeLabels = labels.filter((l) => l.relationship === 'active_client');
  const pastLabels = labels.filter((l) => l.relationship === 'past_client');
  const genresServed = [...new Set(artists.flatMap((a) => a.genres))];

  return `Active label clients: ${activeLabels.map((l) => l.name).join(', ')}
Past label clients: ${pastLabels.map((l) => l.name).join(', ')}
Genres we serve: ${genresServed.slice(0, 15).join(', ')}
Total artists worked with: ${artists.filter((a) => a.hasWorkedWithRT).length}
Artist tier distribution: ${JSON.stringify(getTierDistribution(artists))}`;
}

function getTierDistribution(artists: Artist[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const a of artists.filter((a) => a.hasWorkedWithRT)) {
    dist[a.tier] = (dist[a.tier] ?? 0) + 1;
  }
  return dist;
}

import type { Env } from '../lib/env';
import type { Label, OutreachSignal } from '../lib/types';
import { getTrackedLabels } from '../integrations/notion';
import { getNewReleasesByLabel, searchArtistsByLabel, computeReleaseCadence, getArtistReleases } from '../integrations/spotify';

export interface WatchResult {
  labelsScanned: number;
  newReleases: number;
  signalsGenerated: OutreachSignal[];
  errors: string[];
}

/**
 * Daily scan: check all tracked labels for new releases and upcoming windows.
 * Generates OutreachSignals when it detects timing opportunities.
 */
export async function runLabelWatcher(env: Env): Promise<WatchResult> {
  const result: WatchResult = {
    labelsScanned: 0,
    newReleases: 0,
    signalsGenerated: [],
    errors: [],
  };

  // Get all labels we're tracking from Notion
  const labels = await getTrackedLabels(env);
  result.labelsScanned = labels.length;

  // Check each label for new releases (parallel, with error tolerance)
  const checks = labels.map((label) => checkLabel(env, label));
  const outcomes = await Promise.allSettled(checks);

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    if (outcome.status === 'fulfilled') {
      result.newReleases += outcome.value.releaseCount;
      result.signalsGenerated.push(...outcome.value.signals);
    } else {
      result.errors.push(`${labels[i].name}: ${outcome.reason}`);
    }
  }

  // Save state to KV
  await env.STATE.put(
    'last_release_scan',
    JSON.stringify({
      timestamp: new Date().toISOString(),
      labelsScanned: result.labelsScanned,
      signalsGenerated: result.signalsGenerated.length,
    }),
  );

  return result;
}

async function checkLabel(
  env: Env,
  label: Label,
): Promise<{ releaseCount: number; signals: OutreachSignal[] }> {
  const signals: OutreachSignal[] = [];

  // Check for new releases in the past week
  const newReleases = await getNewReleasesByLabel(env, label.spotifyLabelName, 7);

  if (newReleases.length > 0) {
    // New releases mean the label is active — good time to reach out about other artists
    signals.push({
      type: 'upcoming_release',
      description: `${label.name} dropped ${newReleases.length} release(s) this week: ${newReleases.map((r) => r.name).join(', ')}`,
      strength: 0.7,
      detectedAt: new Date().toISOString(),
    });
  }

  // Check roster for artists we haven't worked with
  const roster = await searchArtistsByLabel(env, label.spotifyLabelName);
  const unworkedArtists = roster.filter((a) => a.followers > 5000); // minimum threshold

  // For each unworked artist with decent following, check their cadence
  for (const artist of unworkedArtists.slice(0, 5)) {
    // Limit API calls
    const releases = await getArtistReleases(env, artist.id, 10);
    const cadence = computeReleaseCadence(releases);

    if (cadence && isInOutreachWindow(cadence)) {
      signals.push({
        type: 'upcoming_release',
        description: `${artist.name} (${label.name}) averages releases every ${cadence.averageDaysBetweenReleases} days. Next expected: ${cadence.nextExpectedWindow}`,
        strength: cadence.confidence,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  return { releaseCount: newReleases.length, signals };
}

/**
 * Returns true if the next expected release is 2-4 weeks out (ideal outreach window).
 */
function isInOutreachWindow(cadence: { nextExpectedWindow: string; confidence: number }): boolean {
  if (cadence.confidence < 0.3) return false;

  const nextDate = new Date(cadence.nextExpectedWindow);
  const now = new Date();
  const daysUntil = (nextDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  // Outreach window: 14-28 days before expected release
  return daysUntil >= 14 && daysUntil <= 28;
}

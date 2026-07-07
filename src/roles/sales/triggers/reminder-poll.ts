/**
 * T-30 pre-call reminder — runs on the 5-min cron alongside the pollers.
 *
 * When a brief completes, the agent drops a `reminder:{eventUri}` record in
 * KV. Each tick scans those records and, for meetings starting within the
 * next 30 minutes, posts a compact refresher card to the host's brief
 * channel: fresh Chartmetric popularity for the top 3 songs + last 3
 * releases, an @-mention of whichever host's Calendly was booked (Eric or
 * Seeno), and the Notion deal link. The record is deleted after a
 * successful post, so each meeting gets exactly one reminder; records for
 * meetings already started are swept.
 */

import type { Env } from "../../../lib/env";
import {
  enrichFromChartmetric,
  type ChartmetricEnrichment,
} from "../../../integrations/chartmetric";
import {
  enrichFromSongstats,
  type SongstatsEnrichment,
} from "../../../integrations/songstats";
import { notifySlack, notionUrl, type SlackMessage } from "../../../integrations/slack";

export const REMINDER_PREFIX = "reminder:";
const WINDOW_MS = 30 * 60 * 1000;

/** Written by pre-call-brief on success; consumed (and deleted) here. */
export interface ReminderRecord {
  /** ISO meeting start time. */
  startsAt: string;
  /** Slack channel for the card (defaults to SLACK_BRIEF_CHANNEL_ID). */
  channelId?: string;
  /** Host to @-mention — whichever Calendly was booked (Eric/Seeno). */
  hostSlackUserId?: string;
  inviteeName: string;
  inviteeEmail: string;
  /** Best-known artist name (Songstats name when available). */
  artistName: string;
  spotifyArtistId: string | null;
  /** Notion deal page id — links back to the full brief. */
  pageId: string;
}

export async function sendPreCallReminders(
  env: Env,
): Promise<{ sent: number; scanned: number }> {
  const list = await env.STATE.list({ prefix: REMINDER_PREFIX });
  let sent = 0;

  for (const key of list.keys) {
    const raw = await env.STATE.get(key.name);
    if (!raw) continue;

    let rec: ReminderRecord;
    try {
      rec = JSON.parse(raw) as ReminderRecord;
    } catch {
      await env.STATE.delete(key.name); // unparseable — sweep
      continue;
    }

    const untilStart = Date.parse(rec.startsAt) - Date.now();
    if (Number.isNaN(untilStart) || untilStart <= 0) {
      await env.STATE.delete(key.name); // meeting started/passed — sweep
      continue;
    }
    if (untilStart > WINDOW_MS) continue; // not yet — later tick handles it

    // Fresh popularity scores. Best-effort: the 24h Chartmetric cache from
    // booking time has usually expired by call day, so this is a live refetch
    // (≤3 API calls, inside the existing daily budget/circuit breaker).
    const chartmetric = await enrichFromChartmetric(
      { spotifyArtistId: rec.spotifyArtistId, artistName: rec.artistName },
      env,
    ).catch((err) => {
      console.warn("reminder_chartmetric_failed", { message: (err as Error).message });
      return null;
    });

    // Songstats fallback: Chartmetric prod access is down as of 2026-07-06
    // (refresh token revoked — "does not exist"; needs regeneration in the
    // Chartmetric dashboard). Songstats top tracks carry popularity too, so
    // the card degrades to top-3-only instead of no scores at all.
    const songstats =
      chartmetric === null && rec.spotifyArtistId
        ? await enrichFromSongstats(rec.spotifyArtistId, env).catch((err) => {
            console.warn("reminder_songstats_failed", { message: (err as Error).message });
            return null;
          })
        : null;

    const res = await notifySlack(
      env,
      rec.channelId ?? env.SLACK_BRIEF_CHANNEL_ID,
      buildReminderMessage(rec, chartmetric, songstats),
    );
    if (res.ok || res.skipped) {
      // Sent (or deliberately unconfigured) — either way this meeting is done.
      await env.STATE.delete(key.name);
      if (res.ok) sent++;
      console.log("reminder_sent", { invitee: rec.inviteeEmail, startsAt: rec.startsAt });
    }
    // A real Slack failure keeps the record: retried next tick until stale.
  }

  return { sent, scanned: list.keys.length };
}

/** Pure builder for the T-30 card — exported for tests. */
export function buildReminderMessage(
  rec: ReminderRecord,
  cm: ChartmetricEnrichment | null,
  ss: SongstatsEnrichment | null = null,
): SlackMessage {
  const mention = rec.hostSlackUserId ? `<@${rec.hostSlackUserId}> ` : "";
  const time = new Date(rec.startsAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  });
  const headline = `⏰ ${mention}call in 30 min — *${rec.inviteeName}* at ${time} ET`;

  const pop = (n: number | null) => (n == null ? "–" : String(n));
  const lines: string[] = [];

  // Chartmetric first; Songstats top tracks (by streams, with popularity)
  // when Chartmetric is unavailable.
  const top =
    cm?.topTracks?.slice(0, 3).map((t) => ({ name: t.name, pop: t.spotifyPopularity })) ??
    ss?.topTracks?.slice(0, 3).map((t) => ({ name: t.name, pop: t.popularity })) ??
    [];
  if (top.length > 0) {
    lines.push("*Top 3 songs (Spotify popularity)*");
    for (const t of top) lines.push(`• ${t.name} — *${pop(t.pop)}*`);
  }

  const latest = cm?.latestTracks?.slice(0, 3) ?? [];
  if (latest.length > 0) {
    lines.push("*Last 3 releases*");
    for (const t of latest) {
      lines.push(`• ${t.name} (${t.releaseDate ?? "date n/a"}) — *${pop(t.spotifyPopularity)}*`);
    }
  }

  if (cm?.cmScore != null) {
    lines.push(
      `Chartmetric score *${cm.cmScore}*${cm.cmRank != null ? ` · rank #${cm.cmRank}` : ""}`,
    );
  } else if (ss?.spotify.popularity != null) {
    lines.push(`Spotify artist popularity *${ss.spotify.popularity}*`);
  }
  if (lines.length === 0) {
    lines.push("_No fresh streaming scores available for this prospect._");
  }

  return {
    text: headline,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: headline } },
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${notionUrl(rec.pageId)}|Open full brief in Notion> │ ${rec.inviteeEmail}`,
          },
        ],
      },
    ],
  };
}

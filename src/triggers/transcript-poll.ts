/**
 * Transcript poll — runs on a cron schedule (every 5 min by default).
 *
 * Lists Drive transcript files modified since the last successful poll, downloads
 * each, resolves to its Notion deal record, and runs the post-call pitch agent.
 *
 * Also runs a **gap detector**: checks Calendly for recently-ended meetings and
 * warns if no transcript has appeared within 30 min of meeting end. This catches
 * misconfigured auto-recording before it silently drops meetings.
 *
 * Cursor (`transcript-poll:cursor`) is stored in KV so the cron is stateful
 * across cold-starts. If KV is not bound yet, falls back to "modified in last
 * 10 min" — still safe because the post-call agent deduplicates per-deal.
 */

import type { Env } from "../lib/env";
import { listMeetTranscriptsSince, downloadTranscriptText } from "../integrations/google-drive";
import { runPostCallPitch } from "../agents/post-call-pitch";

const CURSOR_KEY = "transcript-poll:cursor";
const LOOKBACK_MS = 10 * 60 * 1000; // fallback window if no cursor
const GAP_THRESHOLD_MS = 30 * 60 * 1000; // warn if no transcript 30 min after meeting end
const GAP_CHECK_WINDOW_MS = 4 * 60 * 60 * 1000; // look back 4 hours for ended meetings
const GAP_ALERTED_PREFIX = "transcript-gap:alerted:"; // KV prefix for dedup

export async function pollTranscripts(env: Env): Promise<{ processed: number; gaps: number }> {
  const since = await loadCursor(env);
  const files = await listMeetTranscriptsSince(since, env);

  let processed = 0;
  for (const file of files) {
    try {
      const text = await downloadTranscriptText(file, env);
      const startedAt = file.inferredMeetingStart ?? file.createdTime;
      await runPostCallPitch({
        meetingTitle: file.name,
        startedAt,
        endedAt: file.modifiedTime,
        // Drive doesn't reliably expose attendees; resolver in notion.ts will
        // fall back to fuzzy match by start-time window if attendees empty.
        attendees: [],
        transcript: text,
        transcriptSourceUrl: file.webViewLink,
      }, env);
      processed++;
    } catch (err) {
      console.error("transcript_poll_file_error", { file: file.name, err: (err as Error).message });
    }
  }

  await saveCursor(env, new Date().toISOString());

  // Gap detection: check for meetings that ended but have no transcript
  const gaps = await detectTranscriptGaps(files, env);

  return { processed, gaps };
}

/**
 * Checks Calendly for recently-ended meetings and warns if no matching
 * transcript was found in the current poll. Alerts once per meeting via KV.
 *
 * NOTE: When Fireflies is configured (FIREFLIES_API_KEY is set), gap detection
 * is skipped because transcripts arrive via webhook, not Drive.
 */
async function detectTranscriptGaps(
  foundFiles: Array<{ name: string; inferredMeetingStart?: string }>,
  env: Env,
): Promise<number> {
  // Skip gap detection when Fireflies is the primary transcript source —
  // transcripts arrive via /webhooks/fireflies, not Drive.
  if (env.FIREFLIES_API_KEY) return 0;

  if (!env.CALENDLY_PERSONAL_ACCESS_TOKEN) return 0;

  const now = Date.now();
  const windowStart = new Date(now - GAP_CHECK_WINDOW_MS).toISOString();
  const cutoff = new Date(now - GAP_THRESHOLD_MS); // only flag if ended 30+ min ago

  try {
    const params = new URLSearchParams({
      user: "https://api.calendly.com/users/068c5c2e-6a61-4c2c-bfe7-4cd4b3358eaa",
      sort: "start_time:desc",
      min_start_time: windowStart,
      max_start_time: new Date().toISOString(),
      status: "active",
      count: "10",
    });

    const res = await fetch(`https://api.calendly.com/scheduled_events?${params.toString()}`, {
      headers: { authorization: `Bearer ${env.CALENDLY_PERSONAL_ACCESS_TOKEN}` },
    });

    if (!res.ok) {
      console.warn("gap_detect_calendly_failed", { status: res.status });
      return 0;
    }

    const body = (await res.json()) as {
      collection: Array<{ uri: string; name: string; end_time: string; start_time: string }>;
    };

    let gaps = 0;
    for (const event of body.collection ?? []) {
      const endTime = new Date(event.end_time);
      if (endTime > cutoff) continue; // meeting ended less than 30 min ago, give it time

      // Check if we already alerted for this event
      const alertKey = `${GAP_ALERTED_PREFIX}${event.uri}`;
      const alreadyAlerted = await env.STATE.get(alertKey);
      if (alreadyAlerted) continue;

      // Check if any found transcript roughly matches this meeting time
      const hasTranscript = foundFiles.some((f) => {
        if (!f.inferredMeetingStart) return false;
        const diff = Math.abs(
          new Date(f.inferredMeetingStart).getTime() - new Date(event.start_time).getTime(),
        );
        return diff < 60 * 60 * 1000; // within 1 hour
      });

      if (!hasTranscript) {
        gaps++;
        console.warn("transcript_gap_detected", {
          meeting: event.name,
          endedAt: event.end_time,
          minutesAgo: Math.round((now - endTime.getTime()) / 60_000),
          message: "Meeting ended but no transcript found in Drive. Check Google Meet auto-recording settings.",
        });

        // Notify Slack if configured
        if (env.SLACK_BOT_TOKEN && env.SLACK_BRIEF_CHANNEL_ID) {
          await notifyTranscriptGap(event, env);
        }

        // Mark as alerted (expire after 24h so we don't alert forever)
        await env.STATE.put(alertKey, new Date().toISOString(), { expirationTtl: 86400 });
      }
    }

    return gaps;
  } catch (err) {
    console.error("gap_detect_error", { error: (err as Error).message });
    return 0;
  }
}

async function notifyTranscriptGap(
  event: { name: string; end_time: string; start_time: string },
  env: Env,
): Promise<void> {
  try {
    const endedAt = new Date(event.end_time).toLocaleString("en-US", { timeZone: "America/New_York" });
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel: env.SLACK_BRIEF_CHANNEL_ID,
        text: [
          `:warning: *Transcript gap detected*`,
          `Meeting "${event.name}" ended at ${endedAt} ET but no transcript appeared in Drive.`,
          `The post-call pitch agent can't run without a transcript.`,
          `Check: Admin Console → Google Meet → auto-recording/transcription settings.`,
        ].join("\n"),
      }),
    });
  } catch {
    // Slack notification is best-effort
  }
}

async function loadCursor(env: Env): Promise<string> {
  const v = await env.STATE.get(CURSOR_KEY);
  if (v) return v;
  return new Date(Date.now() - LOOKBACK_MS).toISOString();
}

async function saveCursor(env: Env, iso: string): Promise<void> {
  await env.STATE.put(CURSOR_KEY, iso);
}

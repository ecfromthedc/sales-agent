/**
 * Transcript poll — runs on a cron schedule (every 5 min by default).
 *
 * Lists Drive transcript files modified since the last successful poll, downloads
 * each, resolves to its Notion deal record, and runs the post-call pitch agent.
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

export async function pollTranscripts(env: Env): Promise<{ processed: number }> {
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
  return { processed };
}

async function loadCursor(env: Env): Promise<string> {
  const v = await env.STATE.get(CURSOR_KEY);
  if (v) return v;
  return new Date(Date.now() - LOOKBACK_MS).toISOString();
}

async function saveCursor(env: Env, iso: string): Promise<void> {
  await env.STATE.put(CURSOR_KEY, iso);
}

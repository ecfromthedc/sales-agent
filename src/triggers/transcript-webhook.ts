/**
 * Optional transcript webhook — for future Drive push notifications or manual
 * uploads. Today the primary path is the cron-poll in transcript-poll.ts.
 *
 * Accepts a JSON body like:
 *   { fileId: "drive-file-id", meetingTitle?: "...", startedAt?: "..." }
 *
 * Or a Granola-style payload (for future compatibility):
 *   { meeting: {...}, transcript: { text: "..." } }
 */

import type { Env } from "../lib/env";
import { runPostCallPitch } from "../roles/sales/agents/post-call-pitch";
import { downloadTranscriptText, listMeetTranscriptsSince } from "../integrations/google-drive";

export async function handleTranscriptWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();
  let payload: TranscriptWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  // Path A: explicit Drive file ID
  if ("fileId" in payload && payload.fileId) {
    ctx.waitUntil(
      (async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const files = await listMeetTranscriptsSince(since, env);
        const file = files.find((f) => f.id === payload.fileId);
        if (!file) {
          console.warn("transcript_webhook_file_not_found", { fileId: payload.fileId });
          return;
        }
        const text = await downloadTranscriptText(file, env);
        await runPostCallPitch({
          meetingTitle: payload.meetingTitle ?? file.name,
          startedAt: payload.startedAt ?? file.inferredMeetingStart ?? file.createdTime,
          endedAt: file.modifiedTime,
          attendees: payload.attendees ?? [],
          transcript: text,
          transcriptSourceUrl: file.webViewLink,
        }, env);
      })(),
    );
    return json({ ok: true, queued: "post-call-pitch", via: "drive-file" });
  }

  // Path B: inline transcript (e.g., manual upload, future Granola compat)
  if ("transcript" in payload && payload.transcript) {
    ctx.waitUntil(
      runPostCallPitch({
        meetingTitle: payload.meeting?.title ?? "Manual transcript",
        startedAt: payload.meeting?.started_at ?? new Date().toISOString(),
        endedAt: payload.meeting?.ended_at ?? new Date().toISOString(),
        attendees: payload.meeting?.attendees ?? [],
        transcript: payload.transcript.text,
        summary: payload.transcript.summary,
      }, env),
    );
    return json({ ok: true, queued: "post-call-pitch", via: "inline" });
  }

  return json({ error: "missing_fileId_or_transcript" }, 400);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface TranscriptWebhookPayload {
  fileId?: string;
  meetingTitle?: string;
  startedAt?: string;
  attendees?: Array<{ email: string; name?: string }>;
  meeting?: {
    title?: string;
    started_at?: string;
    ended_at?: string;
    attendees?: Array<{ email: string; name?: string }>;
  };
  transcript?: { text: string; summary?: string };
}

/**
 * Fireflies webhook — triggered when a transcript is ready.
 *
 * Fireflies POSTs: { meetingId, eventType: "Transcription completed" }
 * We fetch the full transcript via GraphQL, then hand it to the proposal
 * drafter — transcript completes → proposal drafts straight to Slack for review.
 *
 * Signature verification: x-hub-signature header contains HMAC-SHA256 of
 * the payload, verified against FIREFLIES_WEBHOOK_SECRET.
 */

import type { Env } from "../lib/env";
import { runProposalFromMeeting } from "../roles/sales/agents/proposal-drafter";
import { verifyFirefliesSignature } from "../lib/proposal-security";

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

interface FirefliesWebhookPayload {
  meetingId: string;
  eventType: string;
  clientReferenceId?: string;
}

export async function handleFirefliesWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();

  // Verify signature if secret is configured
  if (env.FIREFLIES_WEBHOOK_SECRET) {
    const signature = req.headers.get("x-hub-signature") ?? "";
    const valid = await verifyFirefliesSignature(rawBody, signature, env.FIREFLIES_WEBHOOK_SECRET);
    if (!valid) {
      console.warn("fireflies_webhook_sig_invalid");
      return json({ error: "invalid_signature" }, 401);
    }
  }

  let payload: FirefliesWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (payload.eventType !== "Transcription completed" || !payload.meetingId) {
    return json({ ok: true, skipped: true, reason: "not_transcription_complete" });
  }

  console.log("fireflies_webhook_received", { meetingId: payload.meetingId });

  // Fetch full transcript in the background, then auto-draft the proposal
  ctx.waitUntil(
    processFirefliesTranscript(payload.meetingId, env),
  );

  return json({ ok: true, queued: "proposal-drafter", meetingId: payload.meetingId });
}

async function processFirefliesTranscript(meetingId: string, env: Env): Promise<void> {
  const transcript = await fetchFirefliesTranscript(meetingId, env);
  if (!transcript) {
    console.error("fireflies_transcript_fetch_failed", { meetingId });
    return;
  }

  // Build plain-text transcript from sentences
  const transcriptText = transcript.sentences
    .map((s: { speaker_name: string; text: string }) => `${s.speaker_name}: ${s.text}`)
    .join("\n");

  // Build attendees list from meeting_attendees
  const attendees = (transcript.meeting_attendees ?? [])
    .filter((a): a is { email: string; displayName?: string; name?: string } => !!a.email)
    .map((a) => ({
      email: a.email,
      name: a.displayName || a.name,
    }));

  // Build summary text from Fireflies AI summary
  const summaryParts: string[] = [];
  if (transcript.summary?.overview) summaryParts.push(transcript.summary.overview);
  if (transcript.summary?.action_items) summaryParts.push(`Action items: ${transcript.summary.action_items}`);
  const summary = summaryParts.join("\n\n") || undefined;

  const meetingDate = transcript.date
    ? new Date(transcript.date).toISOString()
    : new Date().toISOString();

  const durationMs = (transcript.duration ?? 0) * 60 * 1000;
  const endedAt = transcript.date
    ? new Date(new Date(transcript.date).getTime() + durationMs).toISOString()
    : new Date().toISOString();

  console.log("fireflies_transcript_fetched", {
    meetingId,
    title: transcript.title,
    sentences: transcript.sentences.length,
    attendees: attendees.length,
    durationMin: transcript.duration,
  });

  await runProposalFromMeeting({
    meetingTitle: transcript.title ?? "Strategy Session",
    startedAt: meetingDate,
    endedAt,
    attendees,
    transcript: transcriptText,
    summary,
    transcriptSourceUrl: transcript.transcript_url,
  }, env);
}

interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // unix timestamp ms
  duration: number; // minutes
  host_email: string;
  organizer_email: string;
  participants: string[];
  meeting_attendees: Array<{
    displayName?: string;
    email?: string;
    name?: string;
  }>;
  sentences: Array<{
    speaker_name: string;
    text: string;
    start_time: number;
    end_time: number;
  }>;
  summary: {
    overview?: string;
    action_items?: string;
    short_summary?: string;
    keywords?: string;
  };
  transcript_url?: string;
  audio_url?: string;
}

async function fetchFirefliesTranscript(
  meetingId: string,
  env: Env,
): Promise<FirefliesTranscript | null> {
  if (!env.FIREFLIES_API_KEY) {
    console.error("fireflies_no_api_key");
    return null;
  }

  const query = `
    query Transcript($transcriptId: String!) {
      transcript(id: $transcriptId) {
        id
        title
        date
        duration
        host_email
        organizer_email
        participants
        meeting_attendees {
          displayName
          email
          name
        }
        sentences {
          speaker_name
          text
          start_time
          end_time
        }
        summary {
          overview
          action_items
          short_summary
          keywords
        }
        transcript_url
        audio_url
      }
    }
  `;

  const res = await fetch(FIREFLIES_API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.FIREFLIES_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { transcriptId: meetingId },
    }),
  });

  if (!res.ok) {
    console.error("fireflies_api_error", { status: res.status, body: (await res.text()).slice(0, 500) });
    return null;
  }

  const body = (await res.json()) as { data?: { transcript?: FirefliesTranscript }; errors?: unknown[] };
  if (body.errors) {
    console.error("fireflies_graphql_errors", { errors: body.errors });
    return null;
  }

  return body.data?.transcript ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Post-Call Pitch Agent
 *
 * Trigger: transcript file lands in Drive (or manual webhook replay)
 * Time budget: 15 min end-to-end
 *
 * Steps:
 *   1. Resolve the deal record (by attendee email if available, else by start-time window).
 *   2. Have Claude (Opus 4.5 + extended thinking) read the transcript and compose:
 *      a) A custom Swiss-grid HTML pitch deck (rendered to PDF and stored in R2).
 *      b) A follow-up email draft quoting ≥3 transcript moments.
 *      c) A separate internal action-items list.
 *   3. Attach all three to the Notion deal record.
 *   4. Flip deal status: Called → Pitched.
 */

import type { Env } from "../lib/env";
import { resolveDealForMeeting, attachPitchArtifacts, saveTranscript } from "../integrations/notion";
import { composePitch } from "../lib/anthropic";
import { renderPitchPdf } from "../integrations/pdf";
import { recordRun, recordError } from "../lib/run-state";

interface PostCallPitchInput {
  meetingTitle: string;
  startedAt: string;
  endedAt: string;
  attendees: Array<{ email: string; name?: string }>;
  transcript: string;
  summary?: string;
  transcriptSourceUrl?: string;
  dealId?: string;
}

export async function runPostCallPitch(input: PostCallPitchInput, env: Env): Promise<void> {
  const startedAt = Date.now();

  const deal = input.dealId
    ? { id: input.dealId }
    : await resolveDealForMeeting({
        attendees: input.attendees,
        startedAt: input.startedAt,
      }, env);

  if (!deal) {
    console.warn("post_call_pitch_no_deal", {
      meetingTitle: input.meetingTitle,
      startedAt: input.startedAt,
      attendeesCount: input.attendees.length,
    });
    return;
  }

  try {
    await saveTranscript({
      dealId: deal.id,
      transcript: input.transcript,
      summary: input.summary,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      sourceUrl: input.transcriptSourceUrl,
    }, env);

    const pitch = await composePitch({
      deal,
      transcript: input.transcript,
      summary: input.summary,
    }, env);

    const pdfKey = await renderPitchPdf({
      dealId: deal.id,
      html: pitch.deckHtml,
      styleGuide: "swiss-grid",
    }, env);

    await attachPitchArtifacts({
      dealId: deal.id,
      pdfKey,
      emailDraft: pitch.emailDraft,
      actionItems: pitch.actionItems,
      transcriptQuoted: pitch.quotedTranscriptLines,
    }, env);

    const elapsedMs = Date.now() - startedAt;
    console.log("post_call_pitch_complete", {
      dealId: deal.id,
      elapsedMs,
      quotedLines: pitch.quotedTranscriptLines.length,
    });
    await recordRun(env, "pitch");
  } catch (err) {
    console.error("post_call_pitch_failed", { dealId: deal.id, message: (err as Error).message });
    await recordError(env, "pitch");
    throw err;
  }
}

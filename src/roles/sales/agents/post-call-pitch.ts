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

import type { Env } from "../../../lib/env";
import { resolveDealForMeeting, attachPitchArtifacts, saveTranscript } from "../../../integrations/notion";
import { composePitch } from "../../../lib/anthropic";
import { renderPitchPdf } from "../../../integrations/pdf";
import { createGmailDraft } from "../../../integrations/gmail";
import { notifySlack, buildPitchMessage } from "../../../integrations/slack";
import { recordRun, recordError } from "../../../lib/run-state";

// Henry/sales follow-ups are always sent from Eric's account.
const FOLLOW_UP_FROM = "Eric Cromartie <ec@risingtidesent.com>";

/**
 * Create a Gmail DRAFT of the follow-up email (approval gate — SALE-63).
 * Draft-only: a human reviews and sends. Guarded + non-throwing so a draft
 * failure (e.g. the read-only token still lacking gmail.compose scope) never
 * breaks the already-attached pitch artifacts.
 */
async function draftFollowUpEmail(
  input: PostCallPitchInput,
  emailDraft: string,
  env: Env,
): Promise<boolean> {
  const to = input.attendees.find((a) => a.email)?.email?.trim();
  const body = emailDraft?.trim();
  if (!to || !body) {
    console.warn("post_call_pitch_draft_skipped", {
      reason: !to ? "no_recipient" : "no_email_body",
    });
    return false;
  }

  const subject = input.meetingTitle?.trim()
    ? `Following up: ${input.meetingTitle.trim()}`
    : "Following up on our call";

  try {
    const draft = await createGmailDraft(env, { to, from: FOLLOW_UP_FROM, subject, body });
    console.log("post_call_pitch_draft_created", { to, draftId: draft.draftId });
    return true;
  } catch (err) {
    // Non-fatal: log and move on. Most likely cause is the OAuth token still
    // being read-only scoped (needs gmail.compose) — see gmail.ts scope note.
    console.warn("post_call_pitch_draft_failed", { to, message: (err as Error).message });
    return false;
  }
}

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

    // Approval gate (SALE-63): stage the follow-up as a Gmail DRAFT only.
    // Never auto-send — Eric reviews and sends. Guarded so a draft failure
    // doesn't undo the artifacts already attached above.
    const draftStaged = await draftFollowUpEmail(input, pitch.emailDraft, env);

    // Notify the team that a pitch is ready (best-effort; notifySlack no-ops on
    // missing token/channel and never throws into the run path).
    await notifySlack(
      env,
      env.SLACK_PROPOSALS_CHANNEL_ID,
      buildPitchMessage({
        dealId: deal.id,
        meetingTitle: input.meetingTitle,
        quotedLines: pitch.quotedTranscriptLines.length,
        draftStaged,
      }),
    );

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

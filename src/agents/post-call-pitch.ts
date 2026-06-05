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

  // Slack notification — ping Eric that pitch output is ready
  if (env.SLACK_BOT_TOKEN && env.SLACK_BRIEF_CHANNEL_ID) {
    try {
      const notionUrl = `https://www.notion.so/${deal.id.replace(/-/g, "")}`;
      const meetingLabel = input.meetingTitle
        .replace(/- Notes by Gemini$/i, "")
        .replace(/- Transcript.*$/i, "")
        .replace(/Meeting started \d{4}\/\d{2}\/\d{2} \d{2}:\d{2} \w+/i, "")
        .trim() || "Strategy Session";

      const emailPreview = pitch.emailDraft.slice(0, 300).replace(/\n/g, " ");

      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          channel: env.SLACK_BRIEF_CHANNEL_ID,
          text: `Pitch ready: ${meetingLabel}`,
          blocks: [
            {
              type: "header",
              text: { type: "plain_text", text: `Pitch ready: ${meetingLabel}` },
            },
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: [
                  `*Email draft preview:* ${emailPreview}...`,
                  `*Action items:* ${pitch.actionItems.length}`,
                  `*Transcript quotes:* ${pitch.quotedTranscriptLines.length}`,
                ].join("\n"),
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Draft Proposal" },
                  style: "primary",
                  action_id: "draft_proposal",
                  value: deal.id,
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Open in Notion" },
                  url: notionUrl,
                  action_id: "open_notion",
                },
              ],
            },
            {
              type: "context",
              elements: [
                { type: "mrkdwn", text: `${Math.round((Date.now() - startedAt) / 1000)}s to generate` },
              ],
            },
          ],
        }),
      });
    } catch (slackErr) {
      console.warn("pitch_slack_notify_failed", (slackErr as Error).message);
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log("post_call_pitch_complete", {
    dealId: deal.id,
    elapsedMs,
    quotedLines: pitch.quotedTranscriptLines.length,
  });
}

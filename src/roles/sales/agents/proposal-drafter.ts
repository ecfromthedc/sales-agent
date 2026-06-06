/**
 * Proposal Drafter Agent
 *
 * Trigger: Fireflies transcript completes (auto), or manual rerun.
 *
 * Flow:
 *   transcript → composeProposal (Claude) → render house-style HTML
 *   → host on R2 (live link) → attach to Notion → post link to Slack #proposals
 *   for review. Eric refines by replying in the Slack thread (see slack-events.ts).
 *
 * The Gmail "ready-to-send" draft is intentionally out of scope for now.
 */

import type { Env } from "../../../lib/env";
import {
  type Deal,
  attachProposalArtifact,
  getDealById,
  resolveDealForMeeting,
  saveTranscript,
} from "../../../integrations/notion";
import { composeProposal, type ProposalOutput } from "../../../lib/anthropic";
import { renderProposalHtml } from "../integrations/proposal-render";

export interface ProposalDraftResult {
  proposal: ProposalOutput;
  proposalUrl: string;
}

/**
 * Resolve a deal from a completed meeting, persist the transcript, then draft
 * the proposal. This is the Fireflies → proposal entry point.
 */
export async function runProposalFromMeeting(
  input: {
    meetingTitle: string;
    startedAt: string;
    endedAt: string;
    attendees: Array<{ email: string; name?: string }>;
    transcript: string;
    summary?: string;
    transcriptSourceUrl?: string;
    dealId?: string;
  },
  env: Env,
): Promise<void> {
  const resolved = input.dealId
    ? { id: input.dealId }
    : await resolveDealForMeeting({ attendees: input.attendees, startedAt: input.startedAt }, env);

  if (!resolved) {
    console.warn("proposal_from_meeting_no_deal", {
      meetingTitle: input.meetingTitle,
      startedAt: input.startedAt,
      attendees: input.attendees.length,
    });
    return;
  }

  await saveTranscript({
    dealId: resolved.id,
    transcript: input.transcript,
    summary: input.summary,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    sourceUrl: input.transcriptSourceUrl,
  }, env);

  const deal = await getDealById(resolved.id, env);
  if (!deal) {
    console.error("proposal_from_meeting_deal_refetch_failed", { dealId: resolved.id });
    return;
  }

  await runProposalDrafter(deal, env);
}

export async function runProposalDrafter(deal: Deal, env: Env): Promise<ProposalDraftResult> {
  if (!deal.transcript) {
    throw new Error("proposal_requires_transcript");
  }

  const startedAt = Date.now();
  console.log("proposal_drafter_start", { dealId: deal.id, invitee: deal.inviteeEmail });

  const proposal = await composeProposal({
    deal: {
      id: deal.id,
      inviteeEmail: deal.inviteeEmail,
      inviteeName: deal.inviteeName,
      eventStartsAt: deal.eventStartsAt,
      eventUri: deal.eventUri,
      status: deal.status,
    },
    transcript: deal.transcript,
    preCallBrief: deal.brief,
  }, env);

  const proposalUrl = await hostProposal(deal.id, proposal, env);

  await persistAndAttach(deal.id, proposal, proposalUrl, env);

  // Post the proposal to Slack and remember the thread so refine replies map back.
  const ts = await postProposalToSlack(deal, proposal, proposalUrl, env, startedAt);
  if (ts) {
    await env.STATE.put(`proposal:thread:${ts}`, deal.id, { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});
  }

  console.log("proposal_drafter_complete", {
    dealId: deal.id,
    elapsedMs: Date.now() - startedAt,
    missingData: proposal.missingData.length,
    proposalUrl,
  });

  return { proposal, proposalUrl };
}

/**
 * Refine an already-drafted proposal from a Slack thread instruction, re-render,
 * re-host (same URL), and reply in-thread with the updated link.
 */
export async function refineProposal(
  input: { dealId: string; threadTs: string; channel: string; instruction: string },
  env: Env,
): Promise<void> {
  const deal = await getDealById(input.dealId, env);
  if (!deal || !deal.transcript) {
    console.warn("refine_proposal_no_deal_or_transcript", { dealId: input.dealId });
    return;
  }

  const priorRaw = await env.STATE.get(`proposal:current:${input.dealId}`);
  const priorProposal = priorRaw ? (JSON.parse(priorRaw) as ProposalOutput) : undefined;

  const proposal = await composeProposal({
    deal: {
      id: deal.id,
      inviteeEmail: deal.inviteeEmail,
      inviteeName: deal.inviteeName,
      eventStartsAt: deal.eventStartsAt,
      eventUri: deal.eventUri,
      status: deal.status,
    },
    transcript: deal.transcript,
    preCallBrief: deal.brief,
    priorProposal,
    refinement: input.instruction,
  }, env);

  const proposalUrl = await hostProposal(deal.id, proposal, env);
  await persistAndAttach(deal.id, proposal, proposalUrl, env);

  // Reply in the same thread with the updated proposal.
  if (env.SLACK_BOT_TOKEN) {
    await slackPost({
      channel: input.channel,
      thread_ts: input.threadTs,
      text: `Updated — ${proposal.prd.headline}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `:white_check_mark: *Updated proposal* — applied: _${truncate(input.instruction, 140)}_` },
        },
        {
          type: "actions",
          elements: [openProposalButton(proposalUrl)],
        },
      ],
    }, env).catch((e) => console.warn("refine_slack_reply_failed", (e as Error).message));
  }

  console.log("refine_proposal_complete", { dealId: input.dealId, proposalUrl });
}

// ---------- helpers ----------

async function hostProposal(dealId: string, proposal: ProposalOutput, env: Env): Promise<string> {
  const html = renderProposalHtml(proposal);
  const key = `proposals/${dealId}/latest.html`;
  await env.PITCH_PDFS.put(key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });
  const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  return `${base}/p/${dealId}`;
}

async function persistAndAttach(
  dealId: string,
  proposal: ProposalOutput,
  proposalUrl: string,
  env: Env,
): Promise<void> {
  // Keep the latest proposal JSON for the next refine round.
  await env.STATE.put(`proposal:current:${dealId}`, JSON.stringify(proposal), {
    expirationTtl: 60 * 60 * 24 * 30,
  }).catch(() => {});

  await attachProposalArtifact({
    dealId,
    pdfKey: `proposals/${dealId}/latest.html`,
    proposalUrl,
    prd: proposal.prd as unknown as Record<string, unknown>,
    followUpEmail: proposal.followUpEmail,
    internalNotes: proposal.internalNotes,
    assumptions: proposal.assumptions,
    missingData: proposal.missingData,
    sourceClaims: proposal.sourceClaims,
    transcriptQuoted: proposal.quotedTranscriptLines,
  }, env).catch((e) => console.warn("proposal_notion_attach_failed", (e as Error).message));
}

async function postProposalToSlack(
  deal: Deal,
  proposal: ProposalOutput,
  proposalUrl: string,
  env: Env,
  startedAt: number,
): Promise<string | null> {
  if (!env.SLACK_BOT_TOKEN || !env.SLACK_PROPOSALS_CHANNEL_ID) return null;

  const prd = proposal.prd;
  const budgetSummary = prd.budgetOptions.length
    ? prd.budgetOptions.map((o) => `${o.name}: ${o.amount}`).join("  |  ")
    : "Budget TBD";
  const notionUrl = `https://www.notion.so/${deal.id.replace(/-/g, "")}`;

  try {
    const res = await slackPost({
      channel: env.SLACK_PROPOSALS_CHANNEL_ID,
      text: `Proposal ready: ${prd.artist.name} — ${prd.headline}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: `Proposal: ${prd.artist.name}` } },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: [
              `*${prd.headline}*`,
              prd.subheadline,
              ``,
              `*Budget:* ${budgetSummary}`,
              `*Platforms:* ${prd.campaignStrategy.platforms.join(", ") || "TBD"}`,
              `*Creators:* ${prd.creatorRoster.targetCount} — ${prd.creatorRoster.niches.join(", ") || "TBD"}`,
              `*Timeline:* ${prd.timeline.releaseDate ?? "TBD"} → ${prd.timeline.campaignWindow ?? "TBD"}`,
              proposal.missingData.length
                ? `*Missing:* ${proposal.missingData.join(", ")}`
                : ``,
            ].filter(Boolean).join("\n"),
          },
        },
        {
          type: "actions",
          elements: [
            openProposalButton(proposalUrl),
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
            {
              type: "mrkdwn",
              text: `:speech_balloon: Reply in this thread to refine — e.g. _"make tier 2 $8k"_ or _"cut the IG line"_  ·  ${Math.round((Date.now() - startedAt) / 1000)}s`,
            },
          ],
        },
      ],
    }, env);
    return res.ts ?? null;
  } catch (slackErr) {
    console.warn("proposal_slack_notify_failed", (slackErr as Error).message);
    return null;
  }
}

function openProposalButton(url: string) {
  return {
    type: "button",
    text: { type: "plain_text", text: "Open proposal" },
    style: "primary",
    url,
    action_id: "open_proposal_link",
  };
}

async function slackPost(
  body: Record<string, unknown>,
  env: Env,
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
  if (!data.ok) console.warn("slack_post_not_ok", { error: data.error });
  return data;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

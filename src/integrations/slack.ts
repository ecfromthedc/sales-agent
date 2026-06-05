/**
 * Slack notifications (SALE-62)
 *
 * A single, guarded entry point for posting agent-completion notices to Slack.
 * Replaces the duplicated inline `chat.postMessage` calls that lived in the
 * agents. Design goals:
 *
 *   1. NO-OP cleanly when the bot token or channel id is unset (local dev,
 *      partial config) — returns `{ ok: false, skipped: true }` and never calls
 *      the network.
 *   2. NEVER throw into the run path. A Slack outage / 4xx / 5xx is best-effort
 *      signal, not a reason to fail (or undo) a brief or pitch that already
 *      completed. All failures are caught, logged, and swallowed.
 *   3. PURE message builders (`buildBriefMessage`, `buildPitchMessage`) so the
 *      block shape is unit-testable without a network or env.
 *   4. Workers-compatible: raw `fetch`, no SDK, no Node APIs.
 *
 * Messages are factual and carry no secrets.
 */

import type { Env } from "../lib/env";

const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

/** A Slack Block Kit block. Kept loose on purpose — we only build a few shapes. */
export type SlackBlock = Record<string, unknown>;

export interface SlackMessage {
  /** Fallback/notification text (required by Slack for accessibility + push). */
  text: string;
  /** Optional Block Kit blocks for rich rendering. */
  blocks?: SlackBlock[];
}

export interface NotifyResult {
  ok: boolean;
  /** true when we deliberately did nothing (missing token/channel/text). */
  skipped: boolean;
  /** Slack API error code or thrown message, when ok === false && !skipped. */
  error?: string;
}

/** Minimal fetch shape so tests can inject a fake without DOM/Worker globals. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Post a message to Slack. Guarded + non-throwing.
 *
 * @param env      Worker env (reads SLACK_BOT_TOKEN at call time).
 * @param channel  Channel id (e.g. SLACK_BRIEF_CHANNEL_ID). Falsy ⇒ no-op.
 * @param message  Fallback text + optional blocks.
 * @param fetchImpl Injectable fetch (defaults to global `fetch`) — for tests.
 */
export async function notifySlack(
  env: Env,
  channel: string | undefined,
  message: SlackMessage,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<NotifyResult> {
  const token = env.SLACK_BOT_TOKEN?.trim();
  const channelId = channel?.trim();
  const text = message.text?.trim();

  // Guard: any missing piece is a clean no-op, not an error.
  if (!token || !channelId || !text) {
    return { ok: false, skipped: true };
  }

  try {
    const res = await fetchImpl(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel: channelId,
        text,
        ...(message.blocks ? { blocks: message.blocks } : {}),
      }),
    });

    // Slack returns HTTP 200 with `{ ok: false, error }` on logical failures,
    // so we inspect the body, not just the status.
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;

    if (!res.ok || !data?.ok) {
      const error = data?.error ?? `http_${res.status}`;
      console.warn("slack_notify_failed", { channel: channelId, error });
      return { ok: false, skipped: false, error };
    }

    return { ok: true, skipped: false };
  } catch (err) {
    // Network/parse failure — best-effort, never propagate.
    const error = (err as Error).message;
    console.warn("slack_notify_failed", { channel: channelId, error });
    return { ok: false, skipped: false, error };
  }
}

// ---------------------------------------------------------------------------
// Pure message builders — no env, no network, trivially unit-testable.
// ---------------------------------------------------------------------------

const SLACK_SECTION_LIMIT = 2900; // Slack section text block hard limit (3000).

/** Build a Notion page URL from a (possibly hyphenated) page id. */
function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replace(/-/g, "")}`;
}

/**
 * Convert RT's markdown-ish brief text into Slack mrkdwn and clamp to the
 * section block limit. Pure — preserves the exact transform the inline code
 * used so the posted content does not change.
 */
export function briefToSlackMrkdwn(brief: string): string {
  return brief
    .replace(/\*\*([^*]+)\*\*/g, "*$1*") // **bold** → *bold*
    .replace(/^#{1,3}\s+/gm, "*") //          ### heading → *heading
    .replace(/\|/g, "│") //                    table pipes → unicode
    .slice(0, SLACK_SECTION_LIMIT); //         Slack block limit
}

export interface BriefMessageInput {
  inviteeName: string;
  inviteeEmail: string;
  /** Already-formatted meeting time string (caller controls timezone). */
  meetingTime: string;
  brief: string;
  pageId: string;
}

/**
 * Build the pre-call-brief Slack message. Mirrors exactly what the previous
 * inline call posted (header + brief section + Notion/email context).
 */
export function buildBriefMessage(input: BriefMessageInput): SlackMessage {
  const headline = `📋 ${input.inviteeName} — ${input.meetingTime}`;
  return {
    text: `📋 *${input.inviteeName}* — ${input.meetingTime}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headline },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: briefToSlackMrkdwn(input.brief) },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${notionUrl(input.pageId)}|Open in Notion> │ ${input.inviteeEmail}`,
          },
        ],
      },
    ],
  };
}

export interface PitchMessageInput {
  /** Notion deal page id the pitch artifacts were attached to. */
  dealId: string;
  /** Meeting title, when known (falls back to a generic label). */
  meetingTitle?: string;
  /** Count of transcript lines quoted in the pitch (factual, no content). */
  quotedLines: number;
  /** Whether a Gmail follow-up draft was staged (approval gate). */
  draftStaged: boolean;
}

/**
 * Build the post-call-pitch completion Slack message. Factual: which deal,
 * how many transcript moments were quoted, and whether a follow-up draft is
 * waiting for review. No transcript content, no secrets.
 */
export function buildPitchMessage(input: PitchMessageInput): SlackMessage {
  const title = input.meetingTitle?.trim() || "Post-call pitch";
  const headline = `🎯 Pitch ready — ${title}`;
  const detail =
    `*${input.quotedLines}* transcript moment${input.quotedLines === 1 ? "" : "s"} quoted` +
    (input.draftStaged
      ? "\nFollow-up email staged as a Gmail *draft* (review & send)."
      : "\n_No follow-up draft staged._");

  return {
    text: headline,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headline },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: detail },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${notionUrl(input.dealId)}|Open deal in Notion>`,
          },
        ],
      },
      {
        // Entry point for the proposal pipeline: clicking "Draft Proposal"
        // POSTs to /slack/interactions with action_id "draft_proposal" and the
        // deal id as the value, which kicks off runProposalDrafter.
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Draft Proposal" },
            style: "primary",
            action_id: "draft_proposal",
            value: input.dealId,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Open in Notion" },
            url: notionUrl(input.dealId),
            action_id: "open_notion",
          },
        ],
      },
    ],
  };
}

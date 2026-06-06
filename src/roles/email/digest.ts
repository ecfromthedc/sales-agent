/**
 * src/roles/email/digest.ts — post an inbox triage digest to Slack (SALE-119).
 *
 * NOTIFY-ONLY. This module is a thin orchestrator that:
 *   1. runs {@link triageInbox} (SALE-118) — STRICTLY READ-ONLY against Gmail,
 *      and
 *   2. posts a concise summary to Slack via the shared {@link notifySlack}
 *      helper (SALE-62).
 *
 * It does NOT send, draft, or modify any email. The only side effect is a
 * single Slack `chat.postMessage` — and even that is a clean no-op when the
 * target channel id (or the Slack bot token) is unset.
 *
 * Reuse:
 *   - `triageInbox` does all the Gmail work (read-only, injectable fetch).
 *   - `notifySlack` does all the Slack work (guarded + non-throwing): missing
 *     token/channel ⇒ `{ ok: false, skipped: true }`, never a thrown error.
 *
 * Workers-compatible: only `fetch` (threaded through the two reused helpers) —
 * no Node APIs.
 */

import type { Env } from "../../lib/env";
import { notifySlack, type SlackMessage } from "../../integrations/slack";
import { triageInbox } from "./inbox";
import type { InboxDigest, TriagedMsg } from "./inbox";

/** Tier display order + label for the Slack count line (highest concern first). */
const TIER_LABELS: ReadonlyArray<readonly [keyof InboxDigest, string]> = [
  ["action_required", "Action required"],
  ["meeting_info", "Meeting info"],
  ["info_only", "Info only"],
  ["skip", "Skip"],
];

/** Max action-required items to list out by name before truncating (keep it tight). */
const MAX_LISTED_ITEMS = 10;
/** Slack section text block hard limit is 3000; stay clear of it. */
const SLACK_SECTION_LIMIT = 2900;

export interface PostInboxDigestOptions {
  /** Max messages to pull from the inbox (forwarded to triageInbox). */
  max?: number;
  /** Injectable fetch (tests override this; defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

/** Per-tier message counts surfaced to callers (e.g. the /test/email-digest route). */
export interface DigestCounts {
  action_required: number;
  meeting_info: number;
  info_only: number;
  skip: number;
}

/** All-zero counts — used when the run is skipped before any triage happens. */
const ZERO_COUNTS: DigestCounts = {
  action_required: 0,
  meeting_info: 0,
  info_only: 0,
  skip: 0,
};

/** Reduce a triage digest to its per-tier counts. PURE. */
function digestCounts(digest: InboxDigest): DigestCounts {
  return {
    action_required: digest.action_required.length,
    meeting_info: digest.meeting_info.length,
    info_only: digest.info_only.length,
    skip: digest.skip.length,
  };
}

export interface PostInboxDigestResult {
  /** true when a Slack message was actually posted. */
  posted: boolean;
  /** true when the post was deliberately skipped (no channel / no token). */
  skipped?: boolean;
  /** Per-tier counts from the triage run (all-zero when skipped before triage). */
  counts: DigestCounts;
}

// ---------------------------------------------------------------------------
// Pure message builder — no env, no network, trivially unit-testable.
// ---------------------------------------------------------------------------

/** Total message count across all four tiers. */
function totalCount(digest: InboxDigest): number {
  return TIER_LABELS.reduce((sum, [tier]) => sum + digest[tier].length, 0);
}

/** A single line for one action-required item: subject + sender. */
function actionLine(msg: TriagedMsg): string {
  const subject = msg.subject.trim() || "(no subject)";
  const from = msg.from.trim() || "(unknown sender)";
  return `• *${subject}* — ${from}`;
}

/**
 * Build the inbox-digest Slack message from a triage digest. PURE: no env, no
 * network. Shows a one-line count per tier and then lists the action-required
 * items (subject + from), truncated to keep the message tight.
 */
export function buildDigestMessage(digest: InboxDigest): SlackMessage {
  const total = totalCount(digest);
  const headline = `📥 Inbox digest — ${total} message${total === 1 ? "" : "s"}`;

  const countLine = TIER_LABELS.map(
    ([tier, label]) => `${label}: *${digest[tier].length}*`,
  ).join("  •  ");

  const action = digest.action_required;
  let body: string;
  if (action.length === 0) {
    body = "_No action-required items._";
  } else {
    const listed = action.slice(0, MAX_LISTED_ITEMS).map(actionLine);
    const overflow = action.length - listed.length;
    if (overflow > 0) listed.push(`_…and ${overflow} more._`);
    body = `*Action required:*\n${listed.join("\n")}`;
  }

  const sectionText = `${countLine}\n\n${body}`.slice(0, SLACK_SECTION_LIMIT);

  return {
    text: headline,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: headline },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: sectionText },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — read-only triage + notify-only Slack post.
// ---------------------------------------------------------------------------

/**
 * Run a read-only inbox triage and post the digest to Slack.
 *
 * NOTIFY-ONLY: no email is sent, drafted, or modified. The Slack post is a
 * clean no-op (`{ posted: false, skipped: true }`) when
 * `env.SLACK_EMAIL_DIGEST_CHANNEL_ID` (or the Slack bot token) is unset — and
 * never throws on a Slack failure.
 *
 * @returns whether a Slack message was posted, and whether it was skipped.
 */
export async function postInboxDigest(
  env: Env,
  opts: PostInboxDigestOptions = {},
): Promise<PostInboxDigestResult> {
  const channel = env.SLACK_EMAIL_DIGEST_CHANNEL_ID?.trim();

  // Fast no-op: if there's nowhere to post, skip the (read-only) Gmail work too.
  if (!channel) {
    return { posted: false, skipped: true, counts: ZERO_COUNTS };
  }

  const digest = await triageInbox(env, {
    max: opts.max,
    fetchImpl: opts.fetchImpl,
  });

  const counts = digestCounts(digest);
  const message = buildDigestMessage(digest);

  const result = await notifySlack(
    env,
    channel,
    message,
    opts.fetchImpl as unknown as Parameters<typeof notifySlack>[3],
  );

  if (result.skipped) return { posted: false, skipped: true, counts };
  return { posted: result.ok, counts };
}

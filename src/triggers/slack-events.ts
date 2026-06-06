/**
 * Slack Events API handler — the proposal refine loop.
 *
 * Eric replies in a proposal's Slack thread with an edit instruction
 * (e.g. "make tier 2 $8k", "drop the IG line"). We map the thread back to its
 * deal, re-run the proposal with that refinement, re-host the HTML, and reply
 * in-thread with the updated link.
 *
 * Security: every request is verified against SLACK_SIGNING_SECRET using
 * Slack's v0 signing scheme + a 5-minute timestamp freshness window.
 */

import type { Env } from "../lib/env";
import { refineProposal } from "../roles/sales/agents/proposal-drafter";
import { verifySlackRequest } from "../lib/slack-verify";

interface SlackEnvelope {
  type: "url_verification" | "event_callback";
  challenge?: string;
  event_id?: string;
  event?: SlackMessageEvent;
}

interface SlackMessageEvent {
  type: string;
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
}

export async function handleSlackEvent(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();

  // Verify the request actually came from Slack.
  if (!(await verifySlackSignature(req, rawBody, env))) {
    console.warn("slack_event_sig_invalid");
    return new Response("invalid signature", { status: 401 });
  }

  let env_: SlackEnvelope;
  try {
    env_ = JSON.parse(rawBody);
  } catch {
    return new Response("bad json", { status: 400 });
  }

  // Slack's one-time endpoint verification handshake.
  if (env_.type === "url_verification") {
    return new Response(env_.challenge ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  if (env_.type !== "event_callback" || !env_.event) {
    return ok();
  }

  // Dedup Slack's at-least-once retries.
  if (env_.event_id) {
    const seenKey = `slack:event:${env_.event_id}`;
    if (await env.STATE.get(seenKey)) return ok();
    await env.STATE.put(seenKey, "1", { expirationTtl: 60 * 10 }).catch(() => {});
  }

  const event = env_.event;

  // Only human thread replies. Skip bots, edits/deletes, and the parent post.
  const isHumanReply =
    event.type === "message" &&
    !event.bot_id &&
    !event.subtype &&
    !!event.thread_ts &&
    event.thread_ts !== event.ts &&
    !!event.text?.trim() &&
    !!event.channel;

  if (!isHumanReply) return ok();

  // Is this thread a known proposal? (Mapped when the proposal was first posted.)
  const dealId = await env.STATE.get(`proposal:thread:${event.thread_ts}`);
  if (!dealId) return ok();

  console.log("slack_refine_received", { dealId, thread: event.thread_ts });

  ctx.waitUntil(
    refineProposal(
      {
        dealId,
        threadTs: event.thread_ts as string,
        channel: event.channel as string,
        instruction: event.text as string,
      },
      env,
    ).catch((e) => console.error("refine_proposal_failed", { dealId, error: (e as Error).message })),
  );

  return ok();
}

async function verifySlackSignature(req: Request, rawBody: string, env: Env): Promise<boolean> {
  if (!env.SLACK_SIGNING_SECRET) {
    console.warn("slack_signing_secret_missing");
    return false;
  }
  return verifySlackRequest({
    secret: env.SLACK_SIGNING_SECRET,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
    rawBody,
  });
}

function ok(): Response {
  return new Response("", { status: 200 });
}

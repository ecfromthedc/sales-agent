/**
 * Slack interactive message handler.
 *
 * When Eric clicks a button in a Slack message (e.g. "Draft Proposal"),
 * Slack POSTs to /slack/interactions with a URL-encoded payload.
 *
 * We parse the action, dispatch the right agent, and update the
 * original message to show progress.
 */

import type { Env } from "../lib/env";
import { getDealById } from "../integrations/notion";
import { runProposalDrafter } from "../agents/proposal-drafter";

interface SlackInteractionPayload {
  type: "block_actions";
  trigger_id: string;
  user: { id: string; name: string };
  actions: Array<{
    action_id: string;
    value: string;
    block_id: string;
  }>;
  response_url: string;
  message: {
    ts: string;
    blocks: unknown[];
  };
  channel: { id: string };
}

export async function handleSlackInteraction(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const formData = await req.text();
  const params = new URLSearchParams(formData);
  const rawPayload = params.get("payload");
  if (!rawPayload) {
    return new Response("missing payload", { status: 400 });
  }

  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return new Response("invalid payload", { status: 400 });
  }

  if (payload.type !== "block_actions") {
    return new Response("ok", { status: 200 });
  }

  const action = payload.actions?.[0];
  if (!action) return new Response("ok", { status: 200 });

  if (action.action_id === "draft_proposal") {
    const dealId = action.value;

    // Immediately acknowledge + update the message to show it's in progress
    ctx.waitUntil(
      (async () => {
        // Update the original Slack message: replace button with "in progress"
        await fetch(payload.response_url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            replace_original: true,
            text: payload.message?.blocks ? undefined : "Drafting proposal...",
            blocks: replaceButtonWithStatus(payload.message?.blocks, "Drafting proposal..."),
          }),
        });

        // Run the proposal drafter
        try {
          const deal = await getDealById(dealId, env);
          if (!deal) {
            await postToResponseUrl(payload.response_url, "Deal not found — can't draft proposal.");
            return;
          }
          if (!deal.transcript) {
            await postToResponseUrl(payload.response_url, "No transcript on this deal yet — can't draft proposal.");
            return;
          }

          await runProposalDrafter(deal, env);

          // Update message with success
          const notionUrl = `https://www.notion.so/${dealId.replace(/-/g, "")}`;
          await fetch(payload.response_url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              replace_original: false,
              text: `Proposal drafted for ${deal.inviteeName}`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `*Proposal drafted* for ${deal.inviteeName} — email draft + internal notes ready for review.`,
                  },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: { type: "plain_text", text: "Review in Notion" },
                      url: notionUrl,
                      action_id: "open_proposal",
                    },
                  ],
                },
              ],
            }),
          });
        } catch (err) {
          console.error("proposal_from_slack_failed", { dealId, error: (err as Error).message });
          await postToResponseUrl(
            payload.response_url,
            `Proposal draft failed: ${(err as Error).message}`,
          );
        }
      })(),
    );

    // Return 200 immediately so Slack doesn't time out
    return new Response("", { status: 200 });
  }

  // Unknown action — just acknowledge
  return new Response("", { status: 200 });
}

function replaceButtonWithStatus(blocks: unknown[] | undefined, status: string): unknown[] {
  if (!blocks || !Array.isArray(blocks)) {
    return [{ type: "section", text: { type: "mrkdwn", text: status } }];
  }

  return blocks.map((block: any) => {
    if (block.type === "actions") {
      return {
        type: "context",
        elements: [{ type: "mrkdwn", text: `:hourglass_flowing_sand: ${status}` }],
      };
    }
    return block;
  });
}

async function postToResponseUrl(url: string, text: string): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ replace_original: false, text }),
  });
}

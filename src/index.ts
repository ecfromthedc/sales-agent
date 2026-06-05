/**
 * RT Sales Call Agent — Worker entry
 *
 * HTTP routes:
 *   POST /webhooks/calendly       Calendly invitee.created → pre-call brief
 *   POST /webhooks/transcript     Drive push notification (optional, future)
 *   POST /runs/:dealId/:agent     Manual rerun ("pre-call" | "post-call" | "proposal")
 *   GET  /health                  Health check
 *
 * Cron:
 *   *\/5 * * * *  poll Drive for new Meet transcripts → run post-call pitch
 */

import type { Env } from "./lib/env";
import { handleCalendlyWebhook } from "./triggers/calendly-webhook";
import { handleTranscriptWebhook } from "./triggers/transcript-webhook";
import { handleManualRerun } from "./triggers/manual";
import { pollTranscripts } from "./triggers/transcript-poll";
import { pollCalendly } from "./triggers/calendly-poll";
import { handleTestPreCall } from "./triggers/test";
import { handleSlackInteraction } from "./triggers/slack-interactions";
import { handleSlackEvent } from "./triggers/slack-events";
import { handleFirefliesWebhook } from "./triggers/fireflies-webhook";
import { serveProposal } from "./triggers/proposal-public";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /health") {
        return json({ ok: true, service: "rt-sales-call-agent" });
      }

      if (route === "POST /webhooks/calendly") {
        return await handleCalendlyWebhook(req, env, ctx);
      }

      if (route === "POST /webhooks/transcript") {
        return await handleTranscriptWebhook(req, env, ctx);
      }

      if (route === "POST /test/pre-call") {
        return await handleTestPreCall(req, env, ctx);
      }

      if (route === "POST /slack/interactions") {
        return await handleSlackInteraction(req, env, ctx);
      }

      if (route === "POST /slack/events") {
        return await handleSlackEvent(req, env, ctx);
      }

      if (route === "POST /webhooks/fireflies") {
        return await handleFirefliesWebhook(req, env, ctx);
      }

      // Public live proposal link (no auth — clients open this).
      const proposalMatch = url.pathname.match(/^\/p\/([^/]+)$/);
      if (req.method === "GET" && proposalMatch) {
        return await serveProposal(proposalMatch[1], env);
      }

      const manualMatch = url.pathname.match(/^\/runs\/([^/]+)\/(pre-call|post-call|proposal)$/);
      if (req.method === "POST" && manualMatch) {
        const [, dealId, agent] = manualMatch;
        return await handleManualRerun(dealId, agent as "pre-call" | "post-call" | "proposal", env, ctx);
      }

      return json({ error: "not_found", route }, 404);
    } catch (err) {
      console.error("worker_error", err);
      return json({ error: "internal_error", message: (err as Error).message }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      Promise.allSettled([
        pollCalendly(env).then(
          (r) => console.log("calendly_poll_complete", r),
          (err) => console.error("calendly_poll_failed", { message: (err as Error).message }),
        ),
        pollTranscripts(env).then(
          (r) => console.log("transcript_poll_complete", r),
          (err) => console.error("transcript_poll_failed", { message: (err as Error).message }),
        ),
      ]).then(() => undefined),
    );
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

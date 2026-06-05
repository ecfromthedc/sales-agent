/**
 * RT Sales Call Agent — Worker entry
 *
 * HTTP routes:
 *   POST /webhooks/calendly       Calendly invitee.created → pre-call brief
 *   POST /webhooks/transcript     Drive push notification (optional, future)
 *   POST /runs/:dealId/:agent     Manual rerun ("pre-call" | "post-call" | "proposal")
 *   POST /slack/interactions      Slack interactive callbacks (proposal refine/approve)
 *   POST /slack/events            Slack Events API (proposal refine via message)
 *   POST /webhooks/fireflies      Fireflies transcript ready → proposal draft
 *   GET  /p/:dealId               Public live proposal link (client-facing)
 *   GET  /health                  Liveness check (+ KV binding presence)
 *   GET  /status                  Observability: last cron/brief/pitch runs + error counts
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
import { handleSmokeTest } from "./triggers/smoke";
import { readRunState, shapeStatus, recordRun, recordError } from "./lib/run-state";
import { handleSlackInteraction } from "./triggers/slack-interactions";
import { handleSlackEvent } from "./triggers/slack-events";
import { handleFirefliesWebhook } from "./triggers/fireflies-webhook";
import { serveProposal } from "./triggers/proposal-public";

const SERVICE = "rt-sales-call-agent";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === "GET /health") {
        // Liveness + a cheap check that the state store is actually bound.
        return json({
          ok: true,
          service: SERVICE,
          stateBound: typeof env.STATE?.get === "function",
        });
      }

      if (route === "GET /status") {
        // Observability snapshot. Reads only `status:*` KV keys via the pure
        // shaper, so no secret can be surfaced here.
        const raw = await readRunState(env);
        return json(shapeStatus(raw, { service: SERVICE }));
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

      if (route === "POST /test/smoke") {
        return await handleSmokeTest(req, env, ctx);
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
      (async () => {
        await Promise.allSettled([
          pollCalendly(env).then(
            async (r) => {
              console.log("calendly_poll_complete", r);
              await recordRun(env, "calendly-poll");
            },
            async (err) => {
              console.error("calendly_poll_failed", { message: (err as Error).message });
              await recordError(env, "calendly-poll");
            },
          ),
          pollTranscripts(env).then(
            async (r) => {
              console.log("transcript_poll_complete", r);
              await recordRun(env, "transcript-poll");
            },
            async (err) => {
              console.error("transcript_poll_failed", { message: (err as Error).message });
              await recordError(env, "transcript-poll");
            },
          ),
        ]);
        // Stamp the cron tick itself last, so `cron.lastRun` reflects a fully
        // completed scheduled() pass.
        await recordRun(env, "cron");
      })(),
    );
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

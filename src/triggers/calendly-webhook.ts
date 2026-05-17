/**
 * Calendly webhook handler.
 *
 * Subscribes to `invitee.created` events on:
 *   https://calendly.com/ec-risingtidesent/rising-tides-strategy-session
 *
 * On booking, kicks off the pre-call brief agent (async via ctx.waitUntil so we
 * respond to Calendly fast and do the slow work in the background).
 */

import type { Env } from "../lib/env";
import { verifyCalendlySignature } from "../integrations/calendly";
import { runPreCallBrief } from "../agents/pre-call-brief";

export async function handleCalendlyWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("calendly-webhook-signature") ?? "";

  if (!env.CALENDLY_WEBHOOK_SIGNING_KEY) {
    console.warn(
      "[calendly-webhook] CALENDLY_WEBHOOK_SIGNING_KEY is not set — " +
        "skipping signature verification. Set the secret before deploying to production.",
    );
  } else if (!(await verifyCalendlySignature(rawBody, signature, env.CALENDLY_WEBHOOK_SIGNING_KEY))) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), { status: 401 });
  }

  const payload = JSON.parse(rawBody) as CalendlyWebhookPayload;

  if (payload.event !== "invitee.created") {
    return new Response(JSON.stringify({ ok: true, ignored: payload.event }), { status: 200 });
  }

  // Kick off pre-call brief in the background; respond immediately to Calendly.
  ctx.waitUntil(
    runPreCallBrief({
      inviteeEmail: payload.payload.email,
      inviteeName: payload.payload.name,
      eventStartsAt: payload.payload.scheduled_event.start_time,
      eventUri: payload.payload.scheduled_event.uri,
      questionsAndAnswers: payload.payload.questions_and_answers ?? [],
    }, env),
  );

  return new Response(JSON.stringify({ ok: true, queued: "pre-call-brief" }), { status: 200 });
}

interface CalendlyWebhookPayload {
  event: string;
  payload: {
    email: string;
    name: string;
    scheduled_event: {
      uri: string;
      start_time: string;
      end_time: string;
    };
    questions_and_answers?: Array<{ question: string; answer: string }>;
  };
}

/**
 * Calendly webhook handler.
 *
 * Subscribes to `invitee.created` events across Rising Tides hosts (Eric,
 * Seeno, …). The booking's event-type URI routes it to the right host via
 * CALENDLY_SOURCES, which decides the target Slack channel.
 *
 * On booking, kicks off the pre-call brief agent (async via ctx.waitUntil so we
 * respond to Calendly fast and do the slow work in the background).
 */

import type { Env } from "../../../lib/env";
import { verifyCalendlySignature } from "../integrations/calendly";
import { runPreCallBrief } from "../agents/pre-call-brief";
import { sourceForEventType } from "../config/calendly-sources";

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

  // Route by event-type URI → host → Slack channel. Unknown event types fall
  // back to the default host (Eric) so a new link never silently drops.
  const eventTypeUri = payload.payload.scheduled_event.event_type ?? null;
  const source = sourceForEventType(eventTypeUri);

  // Kick off pre-call brief in the background; respond immediately to Calendly.
  ctx.waitUntil(
    runPreCallBrief({
      inviteeEmail: payload.payload.email,
      inviteeName: payload.payload.name,
      inviteePhone: payload.payload.text_reminder_number ?? undefined,
      eventStartsAt: payload.payload.scheduled_event.start_time,
      eventUri: payload.payload.scheduled_event.uri,
      questionsAndAnswers: payload.payload.questions_and_answers ?? [],
      slackChannelId: source.briefChannelId(env),
      hostSlackUserId: source.hostSlackUserId,
    }, env),
  );

  return new Response(
    JSON.stringify({ ok: true, queued: "pre-call-brief", host: source.label }),
    { status: 200 },
  );
}

interface CalendlyWebhookPayload {
  event: string;
  payload: {
    email: string;
    name: string;
    text_reminder_number?: string | null;
    scheduled_event: {
      uri: string;
      start_time: string;
      end_time: string;
      event_type?: string; // event-type URI — routes the booking to its host
    };
    questions_and_answers?: Array<{ question: string; answer: string }>;
  };
}

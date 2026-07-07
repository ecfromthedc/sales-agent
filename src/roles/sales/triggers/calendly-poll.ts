/**
 * Calendly poll — runs on the same cron as transcript poll.
 *
 * Free Calendly plan doesn't allow webhook subscriptions, so we poll the
 * scheduled-events API every 5 min for events with start time in the future.
 *
 * Multi-host: we poll every entry in CALENDLY_SOURCES (Eric, Seeno, …). They
 * share one org, so Eric's org-admin PAT can read each member's events. Each
 * source keeps its own KV cursor and routes its brief to its own Slack channel.
 *
 * Dedup is handled by `upsertDeal` (filter by invitee email + event URI), so
 * re-running the same event is idempotent. The per-source KV cursor narrows the
 * query window so we don't re-process the whole future calendar every tick.
 * The cursor only advances past processed events — a failed brief holds it and
 * is retried on later ticks (capped at MAX_BRIEF_ATTEMPTS, then a Slack alert).
 */

import type { Env } from "../../../lib/env";
import { runPreCallBrief } from "../agents/pre-call-brief";
import { notifySlack } from "../../../integrations/slack";
import { CALENDLY_SOURCES, type CalendlySource } from "../config/calendly-sources";

const CURSOR_PREFIX = "calendly-poll:cursor";
const LOOKBACK_MS = 30 * 60 * 1000; // first run: look back 30 min
const CALENDLY_API = "https://api.calendly.com";

// A failed booking is retried on later ticks (cursor holds before it) up to
// this many attempts, then skipped with a loud Slack alert. The cap keeps a
// poisoned event (e.g. a multi-week Anthropic billing outage) from burning
// enrichment budgets — Chartmetric alone is 3 calls/attempt on a 200/day cap.
const MAX_BRIEF_ATTEMPTS = 5;
const ATTEMPTS_PREFIX = "brief-attempts";
const ATTEMPTS_TTL_S = 7 * 24 * 3600;

// Calendly requires the organization param to read events for any member other
// than the token owner ("Please also specify organization when requesting
// events for a user within your organization"). All RT hosts share this org.
const CALENDLY_ORG_URI = "https://api.calendly.com/organizations/688c1390-6ea0-40f8-91d8-d43674e09f0c";

export async function pollCalendly(env: Env): Promise<{ briefed: number; events: number }> {
  if (!env.CALENDLY_PERSONAL_ACCESS_TOKEN) {
    console.warn("calendly_poll_skipped_no_token");
    return { briefed: 0, events: 0 };
  }

  let briefed = 0;
  let events = 0;

  // Each source is independent: one host's API failure must not block another's.
  for (const source of CALENDLY_SOURCES) {
    try {
      const r = await pollSource(source, env);
      briefed += r.briefed;
      events += r.events;
    } catch (err) {
      console.error("calendly_poll_source_error", {
        source: source.label,
        message: (err as Error).message,
      });
    }
  }

  return { briefed, events };
}

async function pollSource(
  source: CalendlySource,
  env: Env,
): Promise<{ briefed: number; events: number }> {
  const cursorKey = `${CURSOR_PREFIX}:${source.label}`;
  const cursor =
    (await env.STATE.get(cursorKey)) ?? new Date(Date.now() - LOOKBACK_MS).toISOString();

  // Fetch upcoming events (start_time in the future). Sort ascending by start.
  const params = new URLSearchParams({
    user: source.userUri,
    organization: CALENDLY_ORG_URI,
    sort: "start_time:asc",
    min_start_time: new Date().toISOString(),
    count: "20",
  });

  const eventsRes = await fetch(`${CALENDLY_API}/scheduled_events?${params.toString()}`, {
    headers: { authorization: `Bearer ${env.CALENDLY_PERSONAL_ACCESS_TOKEN}` },
  });
  if (!eventsRes.ok) {
    throw new Error(
      `calendly_events_fetch_failed[${source.label}]: ${eventsRes.status} ${await eventsRes.text()}`,
    );
  }
  const eventsBody = (await eventsRes.json()) as CalendlyEventList;
  const events = eventsBody.collection ?? [];

  // Process events created after the cursor, oldest-created first so the
  // cursor can advance strictly in creation order.
  const newEvents = events
    .filter((e) => e.created_at > cursor)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const channelId = source.briefChannelId(env);

  // The cursor only advances past events that were processed (briefed,
  // canceled, or given up on). It used to jump to now() unconditionally, which
  // silently dropped every booking whose brief threw — 14 bookings lost in
  // June '26 during an Anthropic billing outage. A failed event now holds the
  // cursor, gets retried on later ticks, and is only skipped after
  // MAX_BRIEF_ATTEMPTS with a Slack alert.
  let briefed = 0;
  let advanceTo = cursor;
  for (const event of newEvents) {
    if (event.status !== "active") {
      advanceTo = event.created_at;
      continue;
    }
    try {
      const inviteesRes = await fetch(`${event.uri}/invitees?status=active`, {
        headers: { authorization: `Bearer ${env.CALENDLY_PERSONAL_ACCESS_TOKEN}` },
      });
      if (!inviteesRes.ok) {
        throw new Error(`calendly_invitees_failed: ${inviteesRes.status}`);
      }
      const inviteesBody = (await inviteesRes.json()) as CalendlyInviteeList;
      // ponytail: a retried multi-invitee event re-runs already-briefed
      // invitees (upsertDeal dedups the Notion side; Slack repost possible).
      // Strategy calls are 1:1, so per-invitee checkpointing isn't worth it.
      for (const invitee of inviteesBody.collection ?? []) {
        await runPreCallBrief(
          {
            inviteeEmail: invitee.email,
            inviteeName: invitee.name,
            eventStartsAt: event.start_time,
            eventUri: event.uri,
            questionsAndAnswers: invitee.questions_and_answers ?? [],
            slackChannelId: channelId,
            hostSlackUserId: source.hostSlackUserId,
          },
          env,
        );
        briefed++;
      }
      advanceTo = event.created_at;
    } catch (err) {
      const attemptsKey = `${ATTEMPTS_PREFIX}:${event.uri}`;
      const attempts =
        Number.parseInt((await env.STATE.get(attemptsKey)) ?? "0", 10) + 1;
      await env.STATE.put(attemptsKey, String(attempts), {
        expirationTtl: ATTEMPTS_TTL_S,
      });
      console.error("calendly_poll_event_error", {
        source: source.label,
        event: event.uri,
        attempt: attempts,
        err: (err as Error).message,
      });
      if (attempts >= MAX_BRIEF_ATTEMPTS) {
        await notifySlack(env, channelId, {
          text:
            `🚨 Giving up on the pre-call brief for a ${source.label} Calendly booking ` +
            `(${event.start_time}) after ${attempts} attempts.\n` +
            `Last error: \`${(err as Error).message.slice(0, 300)}\`\n${event.uri}`,
        });
        advanceTo = event.created_at; // skip permanently — loudly, never silently
        continue;
      }
      break; // hold the cursor here; retry this event next tick, keep order
    }
  }

  if (advanceTo !== cursor) await env.STATE.put(cursorKey, advanceTo);
  console.log("calendly_poll_source_done", {
    source: source.label,
    events: events.length,
    briefed,
  });
  return { briefed, events: events.length };
}

interface CalendlyEventList {
  collection: Array<{
    uri: string;
    name: string;
    status: "active" | "canceled";
    start_time: string;
    end_time: string;
    created_at: string;
  }>;
}

interface CalendlyInviteeList {
  collection: Array<{
    uri: string;
    email: string;
    name: string;
    status: "active" | "canceled";
    questions_and_answers?: Array<{ question: string; answer: string; position: number }>;
  }>;
}

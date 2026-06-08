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
 */

import type { Env } from "../../../lib/env";
import { runPreCallBrief } from "../agents/pre-call-brief";
import { CALENDLY_SOURCES, type CalendlySource } from "../config/calendly-sources";

const CURSOR_PREFIX = "calendly-poll:cursor";
const LOOKBACK_MS = 30 * 60 * 1000; // first run: look back 30 min
const CALENDLY_API = "https://api.calendly.com";

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

  // Process events created after the cursor.
  const newEvents = events.filter((e) => e.created_at > cursor);
  const channelId = source.briefChannelId(env);

  let briefed = 0;
  for (const event of newEvents) {
    if (event.status !== "active") continue;
    try {
      const inviteesRes = await fetch(`${event.uri}/invitees?status=active`, {
        headers: { authorization: `Bearer ${env.CALENDLY_PERSONAL_ACCESS_TOKEN}` },
      });
      if (!inviteesRes.ok) {
        console.warn("calendly_invitees_failed", {
          source: source.label,
          event: event.uri,
          status: inviteesRes.status,
        });
        continue;
      }
      const inviteesBody = (await inviteesRes.json()) as CalendlyInviteeList;
      for (const invitee of inviteesBody.collection ?? []) {
        await runPreCallBrief(
          {
            inviteeEmail: invitee.email,
            inviteeName: invitee.name,
            eventStartsAt: event.start_time,
            eventUri: event.uri,
            questionsAndAnswers: invitee.questions_and_answers ?? [],
            slackChannelId: channelId,
          },
          env,
        );
        briefed++;
      }
    } catch (err) {
      console.error("calendly_poll_event_error", {
        source: source.label,
        event: event.uri,
        err: (err as Error).message,
      });
    }
  }

  await env.STATE.put(cursorKey, new Date().toISOString());
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

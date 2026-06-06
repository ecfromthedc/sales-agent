/**
 * Calendly poll — runs on the same cron as transcript poll.
 *
 * Free Calendly plan doesn't allow webhook subscriptions, so we poll the
 * scheduled-events API every 5 min for events with start time in the future.
 *
 * Dedup is handled by `upsertDeal` (filter by invitee email + event URI), so
 * re-running the same event is idempotent. The KV cursor narrows the query
 * window so we don't re-process the whole future calendar every tick.
 */

import type { Env } from "../../../lib/env";
import { runPreCallBrief } from "../agents/pre-call-brief";

const CURSOR_KEY = "calendly-poll:cursor";
const LOOKBACK_MS = 30 * 60 * 1000; // first run: look back 30 min

const RT_USER_URI = "https://api.calendly.com/users/068c5c2e-6a61-4c2c-bfe7-4cd4b3358eaa";
const CALENDLY_API = "https://api.calendly.com";

export async function pollCalendly(env: Env): Promise<{ briefed: number; events: number }> {
  if (!env.CALENDLY_PERSONAL_ACCESS_TOKEN) {
    console.warn("calendly_poll_skipped_no_token");
    return { briefed: 0, events: 0 };
  }

  const cursor =
    (await env.STATE.get(CURSOR_KEY)) ??
    new Date(Date.now() - LOOKBACK_MS).toISOString();

  // Fetch upcoming events (start_time in the future). Sort ascending by start.
  const params = new URLSearchParams({
    user: RT_USER_URI,
    sort: "start_time:asc",
    min_start_time: new Date().toISOString(),
    count: "20",
  });

  const eventsRes = await fetch(`${CALENDLY_API}/scheduled_events?${params.toString()}`, {
    headers: { authorization: `Bearer ${env.CALENDLY_PERSONAL_ACCESS_TOKEN}` },
  });
  if (!eventsRes.ok) {
    throw new Error(`calendly_events_fetch_failed: ${eventsRes.status} ${await eventsRes.text()}`);
  }
  const eventsBody = (await eventsRes.json()) as CalendlyEventList;
  const events = eventsBody.collection ?? [];

  // Process events created after the cursor.
  const newEvents = events.filter((e) => e.created_at > cursor);

  let briefed = 0;
  for (const event of newEvents) {
    if (event.status !== "active") continue;
    try {
      const inviteesRes = await fetch(`${event.uri}/invitees?status=active`, {
        headers: { authorization: `Bearer ${env.CALENDLY_PERSONAL_ACCESS_TOKEN}` },
      });
      if (!inviteesRes.ok) {
        console.warn("calendly_invitees_failed", { event: event.uri, status: inviteesRes.status });
        continue;
      }
      const inviteesBody = (await inviteesRes.json()) as CalendlyInviteeList;
      for (const invitee of inviteesBody.collection ?? []) {
        await runPreCallBrief({
          inviteeEmail: invitee.email,
          inviteeName: invitee.name,
          eventStartsAt: event.start_time,
          eventUri: event.uri,
          questionsAndAnswers: invitee.questions_and_answers ?? [],
        }, env);
        briefed++;
      }
    } catch (err) {
      console.error("calendly_poll_event_error", { event: event.uri, err: (err as Error).message });
    }
  }

  await env.STATE.put(CURSOR_KEY, new Date().toISOString());
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

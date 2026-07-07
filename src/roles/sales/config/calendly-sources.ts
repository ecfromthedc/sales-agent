/**
 * Calendly source routing.
 *
 * The sales agent serves pre-call briefs for more than one Rising Tides host.
 * Each host has their own Calendly user (same org, so Eric's org-admin PAT can
 * read everyone's bookings) and may route its brief Slack pings to its own
 * channel. This table is the single source of truth for "which Calendly →
 * whose bookings → which Slack channel".
 *
 * To onboard another host: add an entry with their Calendly user URI, their
 * event-type URI(s) (for webhook routing), and the channel resolver. Resolve
 * URIs with the Calendly API (`/users/me`, `/organization_memberships`,
 * `/event_types?user=<uri>`).
 */

import type { Env } from "../../../lib/env";

export interface CalendlySource {
  /** Stable key for logs + the per-source poll cursor. */
  label: string;
  /** Calendly user URI — the poll query scope for this host. */
  userUri: string;
  /** Event-type URIs owned by this host — used to route inbound webhooks. */
  eventTypeUris: string[];
  /** Target Slack channel for this host's pre-call briefs (falsy ⇒ no Slack post). */
  briefChannelId: (env: Env) => string | undefined;
  /** Slack user id of the host — @-mentioned in the T-30 pre-call reminder. */
  hostSlackUserId?: string;
}

export const CALENDLY_SOURCES: CalendlySource[] = [
  {
    label: "eric",
    userUri: "https://api.calendly.com/users/068c5c2e-6a61-4c2c-bfe7-4cd4b3358eaa",
    eventTypeUris: [], // default host; webhooks that match nothing else fall here
    briefChannelId: (env) => env.SLACK_BRIEF_CHANNEL_ID,
    hostSlackUserId: "U0727GZMTK5", // ecrom423
  },
  {
    label: "seeno",
    userUri: "https://api.calendly.com/users/285049d5-656a-42df-8c62-373ae13b3a22",
    // https://calendly.com/seeno-risingtidesent/30min — "Rising Tides Strategy Session"
    eventTypeUris: ["https://api.calendly.com/event_types/1e8fe701-e5b7-4816-a4c8-69c8f95478cd"],
    // Splits to its own channel if SLACK_BRIEF_CHANNEL_ID_SEENO is set; otherwise
    // shares the default brief channel (currently the same channel either way).
    briefChannelId: (env) => env.SLACK_BRIEF_CHANNEL_ID_SEENO ?? env.SLACK_BRIEF_CHANNEL_ID,
    hostSlackUserId: "U0AE7U5EBB8", // seeno
  },
];

/** The host bookings route to when no event-type match is found. */
export const DEFAULT_SOURCE = CALENDLY_SOURCES[0];

/** Resolve which host an inbound webhook belongs to, by its event-type URI. */
export function sourceForEventType(eventTypeUri: string | null | undefined): CalendlySource {
  if (eventTypeUri) {
    const match = CALENDLY_SOURCES.find((s) => s.eventTypeUris.includes(eventTypeUri));
    if (match) return match;
  }
  return DEFAULT_SOURCE;
}

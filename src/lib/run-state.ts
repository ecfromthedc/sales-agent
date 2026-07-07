/**
 * Run-state recorder + status payload shaper.
 *
 * The cron pollers and agents write small "I ran" markers into the KV `STATE`
 * namespace so the `/status` endpoint can report liveness and *current* health
 * without touching any secret. The `:errors` counter is a consecutive-failure
 * streak, not a lifetime total: a success clears it, so any non-zero value on
 * `/status` means that kind is failing *right now* (not that it hiccuped once
 * last month). All status keys live under the `status:` prefix
 * to keep them clearly separate from poll cursors (`*-poll:cursor`) and the
 * songstats cache.
 *
 * `shapeStatus` is pure (no I/O) so it's trivially unit-testable and so the
 * redaction contract — "only ever surface these known keys" — is enforced in
 * one place: it never receives, and therefore can never leak, `Env` secrets.
 */

import type { Env } from "./env";

/** A tracked run unit. Each gets a `:last` (ISO timestamp) and `:errors` (consecutive-failure streak) key. */
export type RunKind =
  | "cron" // the scheduled() tick as a whole
  | "calendly-poll"
  | "transcript-poll"
  | "reminder-poll" // T-30 pre-call reminder cards
  | "email-digest" // daily inbox-triage digest (SALE-122; inert until channel set)
  | "brief" // pre-call brief agent
  | "pitch"; // post-call pitch agent

const PREFIX = "status:";
const ALL_KINDS: RunKind[] = [
  "cron",
  "calendly-poll",
  "transcript-poll",
  "reminder-poll",
  "email-digest",
  "brief",
  "pitch",
];

const lastKey = (kind: RunKind) => `${PREFIX}${kind}:last`;
const errKey = (kind: RunKind) => `${PREFIX}${kind}:errors`;

/**
 * Record a successful run: stamp `:last` with the current (or given) time and
 * clear the consecutive-failure streak. Clearing on success is what makes a
 * non-zero `:errors` on `/status` mean "failing right now" — e.g. a poller that
 * accumulated a large lifetime count self-heals to 0 on its next good tick.
 */
export async function recordRun(
  env: Env,
  kind: RunKind,
  at: string = new Date().toISOString(),
): Promise<void> {
  // Best-effort: status bookkeeping must never break the actual run.
  await Promise.all([
    env.STATE.put(lastKey(kind), at).catch(() => {}),
    env.STATE.delete(errKey(kind)).catch(() => {}),
  ]);
}

/** Increment the consecutive-failure streak for a run kind. Best-effort. */
export async function recordError(env: Env, kind: RunKind): Promise<void> {
  try {
    const current = parseCount(await env.STATE.get(errKey(kind)));
    await env.STATE.put(errKey(kind), String(current + 1));
  } catch (err) {
    // swallow — never let observability bookkeeping throw into a run path
    console.warn("record_error_failed", { kind, message: (err as Error).message });
  }
}

/** Raw KV reads handed to the pure shaper. Keys are status-prefixed only. */
export interface RawRunState {
  last: Partial<Record<RunKind, string | null>>;
  errors: Partial<Record<RunKind, string | null>>;
}

/** Read every tracked run's `:last` and `:errors` key from KV. */
export async function readRunState(env: Env): Promise<RawRunState> {
  const last: RawRunState["last"] = {};
  const errors: RawRunState["errors"] = {};
  await Promise.all(
    ALL_KINDS.flatMap((kind) => [
      env.STATE.get(lastKey(kind)).then((v) => {
        last[kind] = v;
      }),
      env.STATE.get(errKey(kind)).then((v) => {
        errors[kind] = v;
      }),
    ]),
  );
  return { last, errors };
}

export interface RunSummary {
  lastRun: string | null;
  errors: number;
}

export interface StatusPayload {
  ok: true;
  service: string;
  /** Wall-clock time the status was computed. */
  generatedAt: string;
  cron: {
    /** Last time the scheduled() handler ran at all. */
    lastRun: string | null;
    calendlyPoll: RunSummary;
    transcriptPoll: RunSummary;
    reminderPoll: RunSummary;
    emailDigest: RunSummary;
  };
  agents: {
    brief: RunSummary;
    pitch: RunSummary;
  };
  /** Sum of every kind's current consecutive-failure streak. 0 ⇒ all healthy. */
  totalErrors: number;
}

/**
 * Shape the public `/status` payload from raw KV values.
 *
 * PURE — no env, no secrets, no I/O. It only ever reads the whitelisted run
 * kinds, so there is no path by which a secret could be surfaced here.
 */
export function shapeStatus(
  raw: RawRunState,
  opts: { service: string; generatedAt?: string },
): StatusPayload {
  const summary = (kind: RunKind): RunSummary => ({
    lastRun: normalizeTs(raw.last[kind]),
    errors: parseCount(raw.errors[kind]),
  });

  const calendlyPoll = summary("calendly-poll");
  const transcriptPoll = summary("transcript-poll");
  const reminderPoll = summary("reminder-poll");
  const emailDigest = summary("email-digest");
  const brief = summary("brief");
  const pitch = summary("pitch");

  const totalErrors =
    parseCount(raw.errors.cron) +
    calendlyPoll.errors +
    transcriptPoll.errors +
    reminderPoll.errors +
    emailDigest.errors +
    brief.errors +
    pitch.errors;

  return {
    ok: true,
    service: opts.service,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    cron: {
      lastRun: normalizeTs(raw.last.cron),
      calendlyPoll,
      transcriptPoll,
      reminderPoll,
      emailDigest,
    },
    agents: { brief, pitch },
    totalErrors,
  };
}

/** Parse a KV-stored counter; missing/garbage → 0. */
function parseCount(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Coerce empty/whitespace timestamps to null so the payload is clean. */
function normalizeTs(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

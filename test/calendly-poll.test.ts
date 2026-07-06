import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/lib/env";

// Regression guard for the June '26 silent-drop incident: the poll cursor used
// to jump to now() even when a brief threw, permanently dropping the booking
// with no notification (14 bookings lost during an Anthropic billing outage).
// New contract:
//   - cursor advances only past processed events (briefed / canceled / given up)
//   - a failed event holds the cursor and is retried on later ticks
//   - after MAX_BRIEF_ATTEMPTS (5) it is skipped WITH a Slack alert

const runPreCallBrief = vi.fn<[unknown, Env], Promise<void>>();
vi.mock("../src/roles/sales/agents/pre-call-brief", () => ({
  runPreCallBrief: (input: unknown, env: Env) => runPreCallBrief(input, env),
}));

const notifySlack = vi.fn(async (..._args: unknown[]) => ({ ok: true, skipped: false }));
vi.mock("../src/integrations/slack", () => ({
  notifySlack: (...args: unknown[]) => notifySlack(...args),
}));

const { pollCalendly } = await import("../src/roles/sales/triggers/calendly-poll");

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeState() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
  };
}

type FakeState = ReturnType<typeof makeState>;

function makeEnv(state: FakeState): Env {
  return {
    STATE: state,
    CALENDLY_PERSONAL_ACCESS_TOKEN: "pat-test",
    SLACK_BRIEF_CHANNEL_ID: "C0B47J6FZ47",
  } as unknown as Env;
}

interface FakeEvent {
  uri: string;
  name: string;
  status: "active" | "canceled";
  start_time: string;
  end_time: string;
  created_at: string;
}

function event(id: string, createdAt: string, status: "active" | "canceled" = "active"): FakeEvent {
  return {
    uri: `https://api.calendly.com/scheduled_events/${id}`,
    name: "Rising Tides Strategy Session",
    status,
    start_time: "2026-08-01T17:00:00.000000Z",
    end_time: "2026-08-01T17:30:00.000000Z",
    created_at: createdAt,
  };
}

/**
 * Stub fetch: the events list returns `eventsByUser[userUri]` (default []),
 * every invitees call returns one invitee.
 */
function stubFetch(eventsByUser: Record<string, FakeEvent[]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/scheduled_events?")) {
        const user = new URL(url).searchParams.get("user") ?? "";
        return {
          ok: true,
          json: async () => ({ collection: eventsByUser[user] ?? [] }),
        };
      }
      if (url.includes("/invitees")) {
        return {
          ok: true,
          json: async () => ({
            collection: [
              { uri: `${url}#i1`, email: "artist@example.com", name: "Artist", status: "active" },
            ],
          }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const ERIC_USER = "https://api.calendly.com/users/068c5c2e-6a61-4c2c-bfe7-4cd4b3358eaa";
const CURSOR_KEY = "calendly-poll:cursor:eric";
const T0 = "2026-07-01T00:00:00.000000Z";

let state: FakeState;
let env: Env;

beforeEach(() => {
  vi.unstubAllGlobals();
  runPreCallBrief.mockReset().mockResolvedValue(undefined);
  notifySlack.mockClear();
  state = makeState();
  // Pin both source cursors so only our fixture events are "new".
  state.store.set(CURSOR_KEY, T0);
  state.store.set("calendly-poll:cursor:seeno", T0);
  env = makeEnv(state);
});

describe("pollCalendly — cursor + retry semantics", () => {
  it("briefs a new booking and advances the cursor to its created_at", async () => {
    stubFetch({ [ERIC_USER]: [event("e1", "2026-07-02T10:00:00.000000Z")] });

    const r = await pollCalendly(env);

    expect(r.briefed).toBe(1);
    expect(runPreCallBrief).toHaveBeenCalledWith(
      expect.objectContaining({
        inviteeEmail: "artist@example.com",
        slackChannelId: "C0B47J6FZ47",
      }),
      env,
    );
    expect(state.store.get(CURSOR_KEY)).toBe("2026-07-02T10:00:00.000000Z");
  });

  it("ignores events at or before the cursor", async () => {
    stubFetch({ [ERIC_USER]: [event("old", T0)] });

    const r = await pollCalendly(env);

    expect(r.briefed).toBe(0);
    expect(runPreCallBrief).not.toHaveBeenCalled();
    expect(state.store.get(CURSOR_KEY)).toBe(T0);
  });

  it("holds the cursor when the brief throws, counts the attempt, and alerts nothing yet", async () => {
    stubFetch({ [ERIC_USER]: [event("e1", "2026-07-02T10:00:00.000000Z")] });
    runPreCallBrief.mockRejectedValue(new Error("anthropic_400: credit balance too low"));

    const r = await pollCalendly(env);

    expect(r.briefed).toBe(0);
    // Cursor must NOT move past the failed event — it retries next tick.
    expect(state.store.get(CURSOR_KEY)).toBe(T0);
    expect(state.store.get("brief-attempts:https://api.calendly.com/scheduled_events/e1")).toBe("1");
    expect(notifySlack).not.toHaveBeenCalled();
  });

  it("a failed older event blocks newer ones so ordering is preserved", async () => {
    stubFetch({
      [ERIC_USER]: [
        event("newer", "2026-07-03T10:00:00.000000Z"),
        event("older", "2026-07-02T10:00:00.000000Z"),
      ],
    });
    runPreCallBrief.mockRejectedValue(new Error("boom"));

    await pollCalendly(env);

    // Only the older event was attempted; the newer one waits behind it.
    expect(runPreCallBrief).toHaveBeenCalledTimes(1);
    expect(runPreCallBrief).toHaveBeenCalledWith(
      expect.objectContaining({ eventUri: "https://api.calendly.com/scheduled_events/older" }),
      env,
    );
    expect(state.store.get(CURSOR_KEY)).toBe(T0);
  });

  it("gives up after MAX attempts with a Slack alert and advances past the event", async () => {
    stubFetch({ [ERIC_USER]: [event("e1", "2026-07-02T10:00:00.000000Z")] });
    runPreCallBrief.mockRejectedValue(new Error("anthropic_400"));
    state.store.set("brief-attempts:https://api.calendly.com/scheduled_events/e1", "4");

    await pollCalendly(env);

    expect(notifySlack).toHaveBeenCalledWith(
      env,
      "C0B47J6FZ47",
      expect.objectContaining({ text: expect.stringContaining("Giving up") }),
    );
    expect(state.store.get(CURSOR_KEY)).toBe("2026-07-02T10:00:00.000000Z");
  });

  it("skips canceled events but still advances the cursor past them", async () => {
    stubFetch({ [ERIC_USER]: [event("c1", "2026-07-02T10:00:00.000000Z", "canceled")] });

    const r = await pollCalendly(env);

    expect(r.briefed).toBe(0);
    expect(runPreCallBrief).not.toHaveBeenCalled();
    expect(state.store.get(CURSOR_KEY)).toBe("2026-07-02T10:00:00.000000Z");
  });

  it("a failed invitees fetch is retryable, not a silent skip", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/scheduled_events?")) {
          const user = new URL(url).searchParams.get("user") ?? "";
          return {
            ok: true,
            json: async () => ({
              collection: user === ERIC_USER ? [event("e1", "2026-07-02T10:00:00.000000Z")] : [],
            }),
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );

    await pollCalendly(env);

    expect(state.store.get(CURSOR_KEY)).toBe(T0);
    expect(state.store.get("brief-attempts:https://api.calendly.com/scheduled_events/e1")).toBe("1");
  });
});

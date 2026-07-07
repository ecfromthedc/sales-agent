import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/lib/env";
import type { ChartmetricEnrichment } from "../src/integrations/chartmetric";

// T-30 pre-call reminder: pre-call-brief drops `reminder:{eventUri}` records
// in KV; the 5-min cron posts a refresher card (fresh Chartmetric popularity
// for top 3 songs + last 3 releases, host @-mention) for meetings starting
// within 30 minutes, then deletes the record (exactly-once). Stale records
// are swept.

const enrichFromChartmetric = vi.fn<[unknown, Env], Promise<ChartmetricEnrichment | null>>();
vi.mock("../src/integrations/chartmetric", () => ({
  enrichFromChartmetric: (q: unknown, env: Env) => enrichFromChartmetric(q, env),
}));

const enrichFromSongstats = vi.fn(async (..._args: unknown[]) => null);
vi.mock("../src/integrations/songstats", () => ({
  enrichFromSongstats: (...args: unknown[]) => enrichFromSongstats(...args),
}));

const notifySlack = vi.fn(async (..._args: unknown[]) => ({ ok: true, skipped: false }));
vi.mock("../src/integrations/slack", async () => {
  const actual = await vi.importActual<typeof import("../src/integrations/slack")>(
    "../src/integrations/slack",
  );
  return { ...actual, notifySlack: (...args: unknown[]) => notifySlack(...args) };
});

const { sendPreCallReminders, buildReminderMessage, REMINDER_PREFIX } = await import(
  "../src/roles/sales/triggers/reminder-poll"
);
type ReminderRecord = import("../src/roles/sales/triggers/reminder-poll").ReminderRecord;

function makeState() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
    delete: vi.fn(async (k: string) => void store.delete(k)),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
    })),
  };
}

type FakeState = ReturnType<typeof makeState>;

const CM: ChartmetricEnrichment = {
  name: "Artist",
  chartmetricId: 1,
  cmScore: 61,
  cmRank: 4242,
  genrePrimary: "soul",
  genresSecondary: [],
  country: "US",
  spotifyMonthlyListeners: null,
  spotifyFollowers: null,
  chartmetricUrl: null,
  topTracks: [
    { name: "Hit One", spotifyPopularity: 55, releaseDate: "2025-01-01" },
    { name: "Hit Two", spotifyPopularity: 41, releaseDate: "2025-06-01" },
    { name: "Hit Three", spotifyPopularity: 38, releaseDate: "2024-03-01" },
    { name: "Hit Four", spotifyPopularity: 30, releaseDate: "2023-01-01" },
  ],
  latestTracks: [
    { name: "New One", spotifyPopularity: 22, releaseDate: "2026-06-26" },
    { name: "New Two", spotifyPopularity: null, releaseDate: "2026-05-06" },
    { name: "New Three", spotifyPopularity: 16, releaseDate: "2026-04-08" },
  ],
};

function record(startsAt: string, over: Partial<ReminderRecord> = {}): string {
  return JSON.stringify({
    startsAt,
    channelId: "C0B47J6FZ47",
    hostSlackUserId: "U0AE7U5EBB8",
    inviteeName: "Teddy Grossman",
    inviteeEmail: "teddy@example.com",
    artistName: "Teddy Grossman",
    spotifyArtistId: "3E0jeQoIrqwpjGuhSIe7H0",
    pageId: "3811465bb829817284b5ca06c3f105df",
    ...over,
  } satisfies ReminderRecord);
}

const inMins = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

let state: FakeState;
let env: Env;

beforeEach(() => {
  enrichFromChartmetric.mockReset().mockResolvedValue(CM);
  enrichFromSongstats.mockReset().mockResolvedValue(null);
  notifySlack.mockReset().mockResolvedValue({ ok: true, skipped: false });
  state = makeState();
  env = { STATE: state, SLACK_BRIEF_CHANNEL_ID: "C0B47J6FZ47" } as unknown as Env;
});

describe("sendPreCallReminders", () => {
  it("sends the card for a meeting inside the 30-min window and deletes the record", async () => {
    state.store.set(`${REMINDER_PREFIX}evt-1`, record(inMins(20)));

    const r = await sendPreCallReminders(env);

    expect(r).toEqual({ sent: 1, scanned: 1 });
    expect(notifySlack).toHaveBeenCalledTimes(1);
    const [, channel, message] = notifySlack.mock.calls[0] as [Env, string, { text: string }];
    expect(channel).toBe("C0B47J6FZ47");
    // Host mention rides in the notification text so it actually pings.
    expect(message.text).toContain("<@U0AE7U5EBB8>");
    expect(message.text).toContain("call in 30 min");
    expect(state.store.has(`${REMINDER_PREFIX}evt-1`)).toBe(false);
  });

  it("leaves records outside the window untouched", async () => {
    state.store.set(`${REMINDER_PREFIX}evt-later`, record(inMins(90)));

    const r = await sendPreCallReminders(env);

    expect(r).toEqual({ sent: 0, scanned: 1 });
    expect(notifySlack).not.toHaveBeenCalled();
    expect(state.store.has(`${REMINDER_PREFIX}evt-later`)).toBe(true);
  });

  it("sweeps records for meetings that already started without posting", async () => {
    state.store.set(`${REMINDER_PREFIX}evt-past`, record(inMins(-10)));

    const r = await sendPreCallReminders(env);

    expect(r).toEqual({ sent: 0, scanned: 1 });
    expect(notifySlack).not.toHaveBeenCalled();
    expect(state.store.has(`${REMINDER_PREFIX}evt-past`)).toBe(false);
  });

  it("keeps the record when the Slack post genuinely fails (retry next tick)", async () => {
    notifySlack.mockResolvedValue({ ok: false, skipped: false, error: "rate_limited" });
    state.store.set(`${REMINDER_PREFIX}evt-1`, record(inMins(20)));

    await sendPreCallReminders(env);

    expect(state.store.has(`${REMINDER_PREFIX}evt-1`)).toBe(true);
  });

  it("still sends when Chartmetric fails — scores are best-effort", async () => {
    enrichFromChartmetric.mockRejectedValue(new Error("cm down"));
    state.store.set(`${REMINDER_PREFIX}evt-1`, record(inMins(10)));

    const r = await sendPreCallReminders(env);

    expect(r.sent).toBe(1);
    expect(notifySlack).toHaveBeenCalledTimes(1);
  });
});

describe("buildReminderMessage", () => {
  const rec = JSON.parse(record(inMins(25))) as ReminderRecord;

  it("includes top 3 songs (of 5) and last 3 releases with popularity scores", () => {
    const msg = buildReminderMessage(rec, CM);
    const body = JSON.stringify(msg.blocks);

    expect(body).toContain("Hit One");
    expect(body).toContain("Hit Three");
    expect(body).not.toContain("Hit Four"); // top THREE only
    expect(body).toContain("New One");
    expect(body).toContain("2026-06-26");
    expect(body).toContain("*55*");
    expect(body).toContain("*–*"); // null popularity renders as a dash
    expect(body).toContain("Chartmetric score *61*");
    expect(body).toContain("notion.so/3811465bb829817284b5ca06c3f105df");
  });

  it("omits the mention cleanly when no host id is known", () => {
    const msg = buildReminderMessage({ ...rec, hostSlackUserId: undefined }, CM);
    expect(msg.text).not.toContain("<@");
  });

  it("degrades to a plain reminder when Chartmetric has nothing", () => {
    const msg = buildReminderMessage(rec, null);
    expect(JSON.stringify(msg.blocks)).toContain("No fresh streaming scores");
    expect(msg.text).toContain("call in 30 min");
  });

  it("falls back to Songstats top tracks when Chartmetric is unavailable", () => {
    const ss = {
      name: "Artist",
      genres: [],
      spotify: { popularity: 27 },
      topTracks: [
        { name: "SS One", popularity: 39 },
        { name: "SS Two", popularity: 19 },
        { name: "SS Three", popularity: 16 },
        { name: "SS Four", popularity: 12 },
      ],
    } as unknown as import("../src/integrations/songstats").SongstatsEnrichment;

    const msg = buildReminderMessage(rec, null, ss);
    const body = JSON.stringify(msg.blocks);

    expect(body).toContain("SS One");
    expect(body).toContain("*39*");
    expect(body).not.toContain("SS Four"); // top THREE only
    expect(body).not.toContain("Last 3 releases"); // Chartmetric-only section
    expect(body).toContain("Spotify artist popularity *27*");
  });
});

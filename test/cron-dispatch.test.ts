import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/lib/env";

// SALE-123 — scheduled() must dispatch by event.cron, not run every handler on
// every tick. wrangler.toml crons = ["*/5 * * * *", "7 13 * * *"]:
//   - "*/5 * * * *"  → fast pollers (pollCalendly + pollTranscripts), NOT digest
//   - "7 13 * * *"   → postInboxDigest ONLY (1 Gmail read/day, not 288)
//   - unrecognized   → safe fallback to the pollers (never the digest)
//
// Two layers:
//   1. handlersForCron(cron) — pure dispatch table, tested directly.
//   2. scheduled() — integration: mock the three handlers, drive each cron, and
//      assert exactly the right ones are called / not called.

const pollCalendly = vi.fn<[Env], Promise<unknown>>();
const pollTranscripts = vi.fn<[Env], Promise<unknown>>();
const sendPreCallReminders = vi.fn<[Env], Promise<unknown>>();
const postInboxDigest = vi.fn<[Env], Promise<unknown>>();

vi.mock("../src/roles/sales/triggers/calendly-poll", () => ({
  pollCalendly: (env: Env) => pollCalendly(env),
}));
vi.mock("../src/roles/sales/triggers/transcript-poll", () => ({
  pollTranscripts: (env: Env) => pollTranscripts(env),
}));
vi.mock("../src/roles/sales/triggers/reminder-poll", () => ({
  sendPreCallReminders: (env: Env) => sendPreCallReminders(env),
}));
vi.mock("../src/roles/email/digest", () => ({
  postInboxDigest: (env: Env) => postInboxDigest(env),
}));

// run-state is mocked so scheduled() records markers without touching KV.
const recordRun = vi.fn(async () => {});
const recordError = vi.fn(async () => {});
vi.mock("../src/lib/run-state", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/run-state")>(
    "../src/lib/run-state",
  );
  return {
    ...actual,
    recordRun: (env: Env, k: string) => recordRun(env, k),
    recordError: (env: Env, k: string) => recordError(env, k),
  };
});

// Imported after mocks are registered.
const worker = (await import("../src/index")).default;
const { handlersForCron } = await import("../src/index");

const ENV = {} as unknown as Env;

// A ctx whose waitUntil captures the promise so the test can await the
// (otherwise fire-and-forget) async work scheduled() kicks off.
function makeCtx(): { ctx: ExecutionContext; settled: () => Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      pending.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return { ctx, settled: async () => void (await Promise.all(pending)) };
}

beforeEach(() => {
  pollCalendly.mockReset().mockResolvedValue({ ok: true });
  pollTranscripts.mockReset().mockResolvedValue({ ok: true });
  sendPreCallReminders.mockReset().mockResolvedValue({ sent: 0, scanned: 0 });
  postInboxDigest.mockReset().mockResolvedValue({ posted: false });
  recordRun.mockClear();
  recordError.mockClear();
});

describe("handlersForCron — pure dispatch table", () => {
  it("maps the 5-min cron to the pollers only", () => {
    expect(handlersForCron("*/5 * * * *")).toEqual(["poll"]);
  });

  it("maps the daily cron to the digest only", () => {
    expect(handlersForCron("7 13 * * *")).toEqual(["digest"]);
  });

  it("falls back to the safe pollers (never the digest) for an unknown cron", () => {
    expect(handlersForCron("0 0 * * 0")).toEqual(["poll"]);
    expect(handlersForCron(undefined)).toEqual(["poll"]);
  });
});

describe("scheduled() — cron dispatch", () => {
  it("on the 5-min cron runs the pollers and NOT the digest", async () => {
    const { ctx, settled } = makeCtx();
    await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledEvent, ENV, ctx);
    await settled();

    expect(pollCalendly).toHaveBeenCalledTimes(1);
    expect(pollTranscripts).toHaveBeenCalledTimes(1);
    expect(sendPreCallReminders).toHaveBeenCalledTimes(1);
    expect(postInboxDigest).not.toHaveBeenCalled();
    // cron tick marker is still stamped.
    expect(recordRun).toHaveBeenCalledWith(ENV, "cron");
  });

  it("on the daily cron runs the digest and NOT the pollers", async () => {
    const { ctx, settled } = makeCtx();
    await worker.scheduled({ cron: "7 13 * * *" } as ScheduledEvent, ENV, ctx);
    await settled();

    expect(postInboxDigest).toHaveBeenCalledTimes(1);
    expect(pollCalendly).not.toHaveBeenCalled();
    expect(pollTranscripts).not.toHaveBeenCalled();
    expect(sendPreCallReminders).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(ENV, "cron");
  });

  it("on an unrecognized cron falls back to the pollers, never the digest", async () => {
    const { ctx, settled } = makeCtx();
    await worker.scheduled({ cron: "0 0 1 1 *" } as ScheduledEvent, ENV, ctx);
    await settled();

    expect(pollCalendly).toHaveBeenCalledTimes(1);
    expect(pollTranscripts).toHaveBeenCalledTimes(1);
    expect(postInboxDigest).not.toHaveBeenCalled();
  });
});

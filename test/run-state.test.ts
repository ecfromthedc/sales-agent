import { describe, it, expect } from "vitest";
import {
  shapeStatus,
  recordRun,
  recordError,
  type RawRunState,
} from "../src/lib/run-state";
import type { Env } from "../src/lib/env";

const empty: RawRunState = { last: {}, errors: {} };

/** Minimal in-memory KV stub — only the methods run-state touches. */
function fakeEnv(): { env: Env; store: Map<string, string> } {
  const store = new Map<string, string>();
  const STATE = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
  };
  return { env: { STATE } as unknown as Env, store };
}

describe("shapeStatus", () => {
  it("produces a clean empty snapshot when KV has nothing", () => {
    const out = shapeStatus(empty, { service: "rt-sales-call-agent", generatedAt: "2026-06-05T00:00:00Z" });
    expect(out).toEqual({
      ok: true,
      service: "rt-sales-call-agent",
      generatedAt: "2026-06-05T00:00:00Z",
      cron: {
        lastRun: null,
        calendlyPoll: { lastRun: null, errors: 0 },
        transcriptPoll: { lastRun: null, errors: 0 },
        reminderPoll: { lastRun: null, errors: 0 },
        emailDigest: { lastRun: null, errors: 0 },
      },
      agents: {
        brief: { lastRun: null, errors: 0 },
        pitch: { lastRun: null, errors: 0 },
      },
      totalErrors: 0,
    });
  });

  it("maps real KV values into the right slots", () => {
    const raw: RawRunState = {
      last: {
        cron: "2026-06-05T12:00:00Z",
        "calendly-poll": "2026-06-05T11:59:00Z",
        "transcript-poll": "2026-06-05T11:58:00Z",
        brief: "2026-06-05T10:00:00Z",
        pitch: "2026-06-05T09:00:00Z",
      },
      errors: {
        "calendly-poll": "2",
        "transcript-poll": "1",
        brief: "3",
        pitch: "0",
        cron: "1",
      },
    };
    const out = shapeStatus(raw, { service: "svc", generatedAt: "2026-06-05T12:00:01Z" });
    expect(out.cron.lastRun).toBe("2026-06-05T12:00:00Z");
    expect(out.cron.calendlyPoll).toEqual({ lastRun: "2026-06-05T11:59:00Z", errors: 2 });
    expect(out.cron.transcriptPoll).toEqual({ lastRun: "2026-06-05T11:58:00Z", errors: 1 });
    expect(out.agents.brief).toEqual({ lastRun: "2026-06-05T10:00:00Z", errors: 3 });
    expect(out.agents.pitch).toEqual({ lastRun: "2026-06-05T09:00:00Z", errors: 0 });
    // 1 (cron) + 2 + 1 + 3 + 0
    expect(out.totalErrors).toBe(7);
  });

  it("treats missing, empty, and garbage counters as 0", () => {
    const raw: RawRunState = {
      last: {},
      errors: { brief: "", pitch: "not-a-number", "calendly-poll": "-4" },
    };
    const out = shapeStatus(raw, { service: "svc" });
    expect(out.agents.brief.errors).toBe(0);
    expect(out.agents.pitch.errors).toBe(0);
    expect(out.cron.calendlyPoll.errors).toBe(0);
    expect(out.totalErrors).toBe(0);
  });

  it("normalizes whitespace-only timestamps to null", () => {
    const raw: RawRunState = { last: { cron: "   ", brief: "\n" }, errors: {} };
    const out = shapeStatus(raw, { service: "svc" });
    expect(out.cron.lastRun).toBeNull();
    expect(out.agents.brief.lastRun).toBeNull();
  });

  it("treats :errors as a consecutive-failure streak that a success clears", async () => {
    const { env, store } = fakeEnv();
    await recordError(env, "transcript-poll");
    await recordError(env, "transcript-poll");
    await recordError(env, "transcript-poll");
    expect(store.get("status:transcript-poll:errors")).toBe("3");

    // A successful run must reset the streak to 0 (key removed ⇒ parsed as 0)
    // so a stale lifetime count can't masquerade as a live outage on /status.
    await recordRun(env, "transcript-poll", "2026-07-02T19:05:00Z");
    expect(store.has("status:transcript-poll:errors")).toBe(false);
    expect(store.get("status:transcript-poll:last")).toBe("2026-07-02T19:05:00Z");

    const out = shapeStatus(
      { last: { "transcript-poll": store.get("status:transcript-poll:last") }, errors: {} },
      { service: "svc" },
    );
    expect(out.cron.transcriptPoll.errors).toBe(0);
  });

  it("only ever surfaces whitelisted keys — no leakage of unexpected raw fields", () => {
    // Even if a caller stuffed a secret-looking value under an unknown key,
    // shapeStatus reads only the known RunKind keys, so it can't appear in output.
    const raw = {
      last: { cron: "2026-06-05T12:00:00Z", ANTHROPIC_API_KEY: "sk-should-never-appear" },
      errors: { NOTION_API_KEY: "ntn-should-never-appear" },
    } as unknown as RawRunState;
    const serialized = JSON.stringify(shapeStatus(raw, { service: "svc" }));
    expect(serialized).not.toContain("sk-should-never-appear");
    expect(serialized).not.toContain("ntn-should-never-appear");
    expect(serialized).not.toContain("API_KEY");
  });
});

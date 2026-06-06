import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Env } from "../src/lib/env";
import type { PostInboxDigestResult } from "../src/roles/email/digest";

// SALE-122 — the auth-gated POST /test/email-digest route handler.
//
// Under test (handler-shaping only; postInboxDigest is mocked so no Gmail/Slack
// network happens):
//   1. Missing/wrong X-Test-Key ⇒ 403, and postInboxDigest is NEVER called.
//   2. Correct X-Test-Key ⇒ 200 with the exact JSON shape
//      { counts: {...}, posted, skipped } forwarded from postInboxDigest.
//   3. skipped defaults to false when postInboxDigest omits it.

const postInboxDigest = vi.fn<[Env], Promise<PostInboxDigestResult>>();

vi.mock("../src/roles/email/digest", () => ({
  postInboxDigest: (env: Env) => postInboxDigest(env),
}));

// Imported after the mock is registered.
const { handleTestEmailDigest } = await import("../src/roles/email/triggers/test-digest");

const ENV = { TEST_AUTH_KEY: "secret-key" } as unknown as Env;
const ctx = {} as ExecutionContext;

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://worker.test/test/email-digest", {
    method: "POST",
    headers,
  });
}

beforeEach(() => {
  postInboxDigest.mockReset();
});

describe("handleTestEmailDigest — auth gate", () => {
  it("rejects with 403 when the X-Test-Key header is missing", async () => {
    const res = await handleTestEmailDigest(req(), ENV, ctx);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(postInboxDigest).not.toHaveBeenCalled();
  });

  it("rejects with 403 when the X-Test-Key header is wrong", async () => {
    const res = await handleTestEmailDigest(req({ "X-Test-Key": "nope" }), ENV, ctx);
    expect(res.status).toBe(403);
    expect(postInboxDigest).not.toHaveBeenCalled();
  });
});

describe("handleTestEmailDigest — authorized", () => {
  it("returns the counts/posted/skipped shape from postInboxDigest", async () => {
    postInboxDigest.mockResolvedValue({
      posted: true,
      skipped: false,
      counts: { action_required: 2, meeting_info: 1, info_only: 3, skip: 5 },
    });

    const res = await handleTestEmailDigest(req({ "X-Test-Key": "secret-key" }), ENV, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      counts: { action_required: 2, meeting_info: 1, info_only: 3, skip: 5 },
      posted: true,
      skipped: false,
    });
    expect(postInboxDigest).toHaveBeenCalledTimes(1);
    expect(postInboxDigest).toHaveBeenCalledWith(ENV);
  });

  it("defaults skipped to false when postInboxDigest omits it", async () => {
    postInboxDigest.mockResolvedValue({
      posted: true,
      counts: { action_required: 0, meeting_info: 0, info_only: 0, skip: 0 },
    });

    const res = await handleTestEmailDigest(req({ "X-Test-Key": "secret-key" }), ENV, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ posted: true, skipped: false });
  });

  it("surfaces the inert no-op shape (skipped:true, zero counts)", async () => {
    postInboxDigest.mockResolvedValue({
      posted: false,
      skipped: true,
      counts: { action_required: 0, meeting_info: 0, info_only: 0, skip: 0 },
    });

    const res = await handleTestEmailDigest(req({ "X-Test-Key": "secret-key" }), ENV, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      counts: { action_required: 0, meeting_info: 0, info_only: 0, skip: 0 },
      posted: false,
      skipped: true,
    });
  });
});

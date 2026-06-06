import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildDigestMessage, postInboxDigest } from "../src/roles/email/digest";
import type { InboxDigest, TriagedMsg } from "../src/roles/email/inbox";
import { __resetGoogleTokenCache } from "../src/integrations/google-auth";
import type { Env } from "../src/lib/env";

// SALE-119 — post the read-only inbox triage digest to Slack (notify-only).
//
// Two concerns under test:
//   1. The PURE `buildDigestMessage` — counts per tier + action_required
//      listing + the empty-digest case. No env, no network.
//   2. `postInboxDigest` is a clean no-op when SLACK_EMAIL_DIGEST_CHANNEL_ID is
//      unset: NO Slack post is attempted (and, because the channel gates the
//      whole flow, no Gmail work happens either). It also NEVER sends/drafts an
//      email — the only ever side effect is a Slack chat.postMessage.

// --- helpers ---------------------------------------------------------------

function msg(partial: Partial<TriagedMsg>): TriagedMsg {
  return {
    id: partial.id ?? "id",
    from: partial.from ?? "Someone <someone@label.com>",
    subject: partial.subject ?? "Subject",
    snippet: partial.snippet ?? "snippet",
    tier: partial.tier ?? "info_only",
    reasons: partial.reasons ?? [],
  };
}

function emptyDigest(): InboxDigest {
  return { action_required: [], meeting_info: [], info_only: [], skip: [] };
}

// =========================================================================
// PURE builder: buildDigestMessage
// =========================================================================

describe("buildDigestMessage — pure", () => {
  it("renders a header + section block with the total in the headline", () => {
    const digest: InboxDigest = {
      action_required: [msg({ id: "a", subject: "Numbers", from: "maya@label.com", tier: "action_required" })],
      meeting_info: [msg({ id: "b", tier: "meeting_info" })],
      info_only: [msg({ id: "c", tier: "info_only" }), msg({ id: "d", tier: "info_only" })],
      skip: [],
    };
    const out = buildDigestMessage(digest);

    // total = 1 + 1 + 2 + 0 = 4
    expect(out.text).toBe("📥 Inbox digest — 4 messages");
    expect(out.blocks?.[0]).toMatchObject({ type: "header" });
    expect(out.blocks?.[1]).toMatchObject({ type: "section" });
  });

  it("shows a count for every tier", () => {
    const digest: InboxDigest = {
      action_required: [msg({ tier: "action_required" })],
      meeting_info: [msg({ tier: "meeting_info" }), msg({ tier: "meeting_info" })],
      info_only: [],
      skip: [msg({ tier: "skip" }), msg({ tier: "skip" }), msg({ tier: "skip" })],
    };
    const section = buildDigestMessage(digest).blocks?.[1] as { text: { text: string } };
    const text = section.text.text;
    expect(text).toContain("Action required: *1*");
    expect(text).toContain("Meeting info: *2*");
    expect(text).toContain("Info only: *0*");
    expect(text).toContain("Skip: *3*");
  });

  it("lists action_required items by subject + from", () => {
    const digest: InboxDigest = {
      ...emptyDigest(),
      action_required: [
        msg({ id: "a", subject: "Campaign numbers", from: "Maya <maya@label.com>", tier: "action_required" }),
        msg({ id: "b", subject: "Contract", from: "Robin <robin@label.com>", tier: "action_required" }),
      ],
    };
    const section = buildDigestMessage(digest).blocks?.[1] as { text: { text: string } };
    const text = section.text.text;
    expect(text).toContain("*Action required:*");
    expect(text).toContain("*Campaign numbers* — Maya <maya@label.com>");
    expect(text).toContain("*Contract* — Robin <robin@label.com>");
  });

  it("truncates the action_required list past the cap with a '…and N more' note", () => {
    const many = Array.from({ length: 13 }, (_, i) =>
      msg({ id: `a${i}`, subject: `S${i}`, tier: "action_required" }),
    );
    const digest: InboxDigest = { ...emptyDigest(), action_required: many };
    const section = buildDigestMessage(digest).blocks?.[1] as { text: { text: string } };
    const text = section.text.text;
    // 10 listed, 3 overflow
    expect(text).toContain("S0");
    expect(text).toContain("S9");
    expect(text).not.toContain("S10");
    expect(text).toContain("…and 3 more.");
  });

  it("falls back to (no subject)/(unknown sender) on blank fields", () => {
    const digest: InboxDigest = {
      ...emptyDigest(),
      action_required: [msg({ subject: "   ", from: "  ", tier: "action_required" })],
    };
    const section = buildDigestMessage(digest).blocks?.[1] as { text: { text: string } };
    expect(section.text.text).toContain("*(no subject)* — (unknown sender)");
  });

  it("handles an empty digest: 0 total, no action items, no throw", () => {
    const out = buildDigestMessage(emptyDigest());
    expect(out.text).toBe("📥 Inbox digest — 0 messages");
    const section = out.blocks?.[1] as { text: { text: string } };
    expect(section.text.text).toContain("Action required: *0*");
    expect(section.text.text).toContain("_No action-required items._");
  });

  it("singularizes the headline for a single message", () => {
    const digest: InboxDigest = { ...emptyDigest(), info_only: [msg({})] };
    expect(buildDigestMessage(digest).text).toBe("📥 Inbox digest — 1 message");
  });
});

// =========================================================================
// postInboxDigest — clean no-op when channel unset (notify-only)
// =========================================================================

beforeEach(() => {
  __resetGoogleTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("postInboxDigest — clean no-op when channel unset", () => {
  it("does not attempt any fetch (Slack or Gmail) and returns skipped", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(typeof input === "string" ? input : input.toString());
      throw new Error("fetch should never be called when channel is unset");
    }) as unknown as typeof fetch;

    const env = { SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env; // channel unset

    const res = await postInboxDigest(env, { fetchImpl });
    expect(res).toEqual({
      posted: false,
      skipped: true,
      counts: { action_required: 0, meeting_info: 0, info_only: 0, skip: 0 },
    });
    expect(calls).toHaveLength(0); // no Slack post, no Gmail read — pure no-op
  });

  it("does not throw when both token and channel are unset", async () => {
    const fetchImpl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const env = {} as unknown as Env;
    const res = await postInboxDigest(env, { fetchImpl });
    expect(res).toEqual({
      posted: false,
      skipped: true,
      counts: { action_required: 0, meeting_info: 0, info_only: 0, skip: 0 },
    });
  });
});

// =========================================================================
// postInboxDigest — end-to-end shape (channel set): triage → Slack post
// =========================================================================

const E2E_ENV = {
  GMAIL_OAUTH_CLIENT_ID: "cid",
  GMAIL_OAUTH_CLIENT_SECRET: "csecret",
  GMAIL_OAUTH_REFRESH_TOKEN: "rtoken",
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_EMAIL_DIGEST_CHANNEL_ID: "C_DIGEST",
} as unknown as Env;

const E2E_MESSAGES: Record<string, { headers: Record<string, string>; snippet: string }> = {
  m_action: {
    headers: { From: "Maya <maya@label.com>", Subject: "Campaign numbers" },
    snippet: "Can you send over the latest TikTok metrics for the rollout?",
  },
};

interface E2ECall {
  url: string;
  method: string;
  body?: string;
}

/**
 * Fake fetch covering: the OAuth token exchange, a one-message inbox
 * `messages.list`, the per-id `messages.get`, AND the Slack chat.postMessage.
 * Records every call so the test can assert exactly one Slack post and zero
 * email send/draft/modify calls.
 */
function makeE2EFetch(calls: E2ECall[]): typeof fetch {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });

    if (url.includes("oauth2.googleapis.com/token")) {
      return json({ access_token: "fake-access-token", expires_in: 3600 });
    }
    if (url.includes("slack.com/api/chat.postMessage")) {
      return json({ ok: true });
    }
    const getMatch = url.match(/\/messages\/([^?]+)/);
    if (getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const m = E2E_MESSAGES[id];
      const headers = Object.entries(m.headers).map(([name, value]) => ({ name, value }));
      return json({ id, snippet: m.snippet, payload: { headers } });
    }
    if (url.includes("/messages?")) {
      return json({ messages: Object.keys(E2E_MESSAGES).map((id) => ({ id })), resultSizeEstimate: 1 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  };

  return fn as unknown as typeof fetch;
}

describe("postInboxDigest — end-to-end (channel set)", () => {
  it("triages the inbox then posts exactly one Slack message; sends/drafts no email", async () => {
    const calls: E2ECall[] = [];
    const fetchImpl = makeE2EFetch(calls);
    vi.stubGlobal("fetch", fetchImpl); // token broker uses global fetch

    const res = await postInboxDigest(E2E_ENV, { fetchImpl });
    expect(res.posted).toBe(true);
    expect(res.skipped).toBeUndefined();
    // Exactly one message was triaged across the four tiers.
    const total =
      res.counts.action_required +
      res.counts.meeting_info +
      res.counts.info_only +
      res.counts.skip;
    expect(total).toBe(1);

    // Exactly one Slack post, to the configured channel, carrying the digest.
    const slackCalls = calls.filter((c) => c.url.includes("slack.com/api/chat.postMessage"));
    expect(slackCalls).toHaveLength(1);
    const slackBody = JSON.parse(slackCalls[0].body ?? "{}");
    expect(slackBody.channel).toBe("C_DIGEST");
    expect(slackBody.text).toContain("Inbox digest");

    // NOTIFY-ONLY: no email send/draft/modify/trash/label endpoint is ever hit.
    const forbidden = ["/send", "/drafts", "/modify", "/trash", "/labels"];
    for (const c of calls) {
      for (const frag of forbidden) {
        expect(c.url.includes(frag)).toBe(false);
      }
    }
    // Only Gmail calls are GETs (token exchange + Slack are the POSTs).
    const gmailCalls = calls.filter((c) => c.url.includes("gmail.googleapis.com"));
    expect(gmailCalls.length).toBeGreaterThan(0);
    for (const c of gmailCalls) expect(c.method).toBe("GET");
  });
});

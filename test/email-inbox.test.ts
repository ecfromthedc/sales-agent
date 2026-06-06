import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { triageInbox, DEFAULT_MAX_MESSAGES } from "../src/roles/email/inbox";
import type { InboxDigest } from "../src/roles/email/inbox";
import { __resetGoogleTokenCache } from "../src/integrations/google-auth";
import type { Env } from "../src/lib/env";

// SALE-118 — read-only inbox triage digest.
//
// These exercise `triageInbox` end-to-end with a fully mocked `fetch`: a token
// exchange, a `messages.list`, and per-id `messages.get` responses. They assert
// the four-tier bucketing AND — the security-critical invariant — that NO
// send/modify/draft/trash/label endpoint is ever touched (read-only).

// A minimal Env with just the OAuth fields the token broker reads.
const env = {
  GMAIL_OAUTH_CLIENT_ID: "cid",
  GMAIL_OAUTH_CLIENT_SECRET: "csecret",
  GMAIL_OAUTH_REFRESH_TOKEN: "rtoken",
} as unknown as Env;

// Four representative inbox messages, one per tier.
const MESSAGES: Record<string, { headers: Record<string, string>; snippet: string }> = {
  m_action: {
    headers: { From: "Maya <maya@label.com>", Subject: "Campaign numbers" },
    snippet: "Can you send over the latest TikTok metrics for the rollout?",
  },
  m_meeting: {
    headers: { From: "Robin <robin@label.com>", Subject: "Calendar invite: Sync at 3pm" },
    snippet: "Adding you to the sync.",
  },
  m_newsletter: {
    headers: {
      From: "The Hustle <team@thehustle.co>",
      Subject: "Your weekly digest is here",
      "List-Unsubscribe": "<mailto:unsub@thehustle.co>",
    },
    snippet: "This week in tech... view in browser to read more.",
  },
  m_noreply: {
    headers: { From: "GitHub <noreply@github.com>", Subject: "Your build status" },
    snippet: "The build completed.",
  },
};

// Endpoints that MUST never be hit — any write/mutation path on the Gmail API.
const FORBIDDEN_FRAGMENTS = [
  "/send",
  "/drafts",
  "/modify",
  "/trash",
  "/untrash",
  "/delete",
  "/batchModify",
  "/labels",
];

interface CallLog {
  urls: string[];
  methods: string[];
}

/**
 * Build a fake `fetch` that serves: the OAuth token endpoint, the inbox
 * `messages.list`, and a `messages.get` per id. Records every URL + method so a
 * test can assert no forbidden endpoint was called.
 */
function makeFetch(ids: string[], log: CallLog): typeof fetch {
  const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    log.urls.push(url);
    log.methods.push((init?.method ?? "GET").toUpperCase());

    // OAuth token exchange.
    if (url.includes("oauth2.googleapis.com/token")) {
      return json({ access_token: "fake-access-token", expires_in: 3600 });
    }

    // messages.get/{id} — must be checked BEFORE the list match.
    const getMatch = url.match(/\/messages\/([^?]+)/);
    if (getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const msg = MESSAGES[id];
      const headers = Object.entries(msg.headers).map(([name, value]) => ({ name, value }));
      return json({ id, snippet: msg.snippet, payload: { headers } });
    }

    // messages.list
    if (url.includes("/messages?")) {
      return json({
        messages: ids.map((id) => ({ id, threadId: `t_${id}` })),
        resultSizeEstimate: ids.length,
      });
    }

    throw new Error(`unexpected fetch to ${url}`);
  };

  return fn as unknown as typeof fetch;
}

beforeEach(() => {
  // Cold token cache each test so the OAuth exchange is exercised deterministically.
  __resetGoogleTokenCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Install `fetch` as BOTH the global (so the shared `getGoogleAccessToken`
 * broker — which uses the global `apiFetch` — is intercepted) and return it so
 * it can also be passed as `fetchImpl` to `triageInbox` (proving the injection
 * path). One mock, every call routed through it and logged.
 */
function installFetch(ids: string[], log: CallLog): typeof fetch {
  const fn = makeFetch(ids, log);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("triageInbox — read-only digest bucketing", () => {
  it("buckets each message into the correct tier", async () => {
    const ids = ["m_action", "m_meeting", "m_newsletter", "m_noreply"];
    const log: CallLog = { urls: [], methods: [] };
    const digest = await triageInbox(env, { fetchImpl: installFetch(ids, log) });

    expect(digest.action_required.map((m) => m.id)).toEqual(["m_action"]);
    expect(digest.meeting_info.map((m) => m.id)).toEqual(["m_meeting"]);
    expect(digest.info_only.map((m) => m.id)).toEqual(["m_newsletter"]);
    expect(digest.skip.map((m) => m.id)).toEqual(["m_noreply"]);
  });

  it("returns the full digest shape with all four tiers present", async () => {
    const log: CallLog = { urls: [], methods: [] };
    const digest = await triageInbox(env, {
      fetchImpl: installFetch(["m_action"], log),
    });
    const keys = Object.keys(digest).sort();
    expect(keys).toEqual(["action_required", "info_only", "meeting_info", "skip"]);
    for (const k of keys) {
      expect(Array.isArray((digest as unknown as Record<string, unknown[]>)[k])).toBe(true);
    }
  });

  it("each TriagedMsg carries id/from/subject/snippet/tier/reasons", async () => {
    const log: CallLog = { urls: [], methods: [] };
    const digest = await triageInbox(env, { fetchImpl: installFetch(["m_action"], log) });
    const msg = digest.action_required[0];
    expect(msg.id).toBe("m_action");
    expect(msg.from).toContain("maya@label.com");
    expect(msg.subject).toBe("Campaign numbers");
    expect(msg.snippet).toContain("TikTok metrics");
    expect(msg.tier).toBe("action_required");
    expect(Array.isArray(msg.reasons)).toBe(true);
    expect(msg.reasons.length).toBeGreaterThan(0);
  });

  it("returns an empty digest (no throw) when the inbox is empty", async () => {
    const log: CallLog = { urls: [], methods: [] };
    const digest = await triageInbox(env, { fetchImpl: installFetch([], log) });
    expect(digest).toEqual<InboxDigest>({
      action_required: [],
      meeting_info: [],
      info_only: [],
      skip: [],
    });
  });
});

describe("triageInbox — read-only invariant (no mutation endpoints)", () => {
  it("only calls messages.list + messages.get (never send/modify/draft/trash/label)", async () => {
    const ids = ["m_action", "m_meeting", "m_newsletter", "m_noreply"];
    const log: CallLog = { urls: [], methods: [] };
    await triageInbox(env, { fetchImpl: installFetch(ids, log) });

    // No forbidden endpoint fragment ever appears in a requested URL.
    for (const url of log.urls) {
      for (const frag of FORBIDDEN_FRAGMENTS) {
        expect(url.includes(frag)).toBe(false);
      }
    }

    // Every Gmail data call is a GET (token exchange is the only POST).
    const gmailCalls = log.urls
      .map((u, i) => ({ u, m: log.methods[i] }))
      .filter((c) => c.u.includes("gmail.googleapis.com"));
    expect(gmailCalls.length).toBeGreaterThan(0);
    for (const c of gmailCalls) {
      expect(c.m).toBe("GET");
    }

    // Exactly: 1 list + N gets.
    const listCalls = log.urls.filter((u) => u.includes("/messages?"));
    const getCalls = log.urls.filter((u) => /\/messages\/[^?]+/.test(u));
    expect(listCalls.length).toBe(1);
    expect(getCalls.length).toBe(ids.length);
  });

  it("requests in:inbox and honors a custom max", async () => {
    const log: CallLog = { urls: [], methods: [] };
    await triageInbox(env, { max: 7, fetchImpl: installFetch(["m_action"], log) });
    const listUrl = log.urls.find((u) => u.includes("/messages?"))!;
    expect(decodeURIComponent(listUrl)).toContain("q=in:inbox");
    expect(listUrl).toContain("maxResults=7");
  });

  it("defaults to DEFAULT_MAX_MESSAGES when no max is given", async () => {
    const log: CallLog = { urls: [], methods: [] };
    await triageInbox(env, { fetchImpl: installFetch(["m_action"], log) });
    const listUrl = log.urls.find((u) => u.includes("/messages?"))!;
    expect(listUrl).toContain(`maxResults=${DEFAULT_MAX_MESSAGES}`);
  });
});

describe("triageInbox — resilience", () => {
  it("tolerates a partial messages.get failure (one bad id is dropped, rest survive)", async () => {
    const ids = ["m_action", "m_meeting"];
    const log: CallLog = { urls: [], methods: [] };
    const good = makeFetch(ids, log);
    // Wrap the fake fetch to fail the get for m_meeting only.
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (/\/messages\/m_meeting/.test(url)) {
        return new Response("boom", { status: 500 });
      }
      return good(input, init);
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", flaky);

    const digest = await triageInbox(env, { fetchImpl: flaky });
    expect(digest.action_required.map((m) => m.id)).toEqual(["m_action"]);
    expect(digest.meeting_info).toEqual([]);
  });
});

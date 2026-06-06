import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildReplyPrompt,
  composeReplyDraft,
  stageReplyDraft,
  REPLY_FROM,
} from "../src/roles/email/reply";
import { __resetGoogleTokenCache } from "../src/integrations/google-auth";
import type { TriagedMsg } from "../src/roles/email/inbox";
import type { Env } from "../src/lib/env";

// SALE-120 — compose a reply DRAFT for an action_required message behind a
// human approval gate. NEVER SEND.
//
// These lock three things:
//   1. buildReplyPrompt is PURE and embeds the message context + the system.
//   2. composeReplyDraft routes through the shared callClaude and returns
//      { to, subject, body } with a `Re:` subject derivation.
//   3. stageReplyDraft creates a Gmail DRAFT only — on a 403 (read-only scope)
//      it returns { staged:false, reason:"needs gmail.compose scope" } and
//      NEVER calls a /send or messages.send endpoint.

const env = {
  ANTHROPIC_API_KEY: "sk-test-key",
  GMAIL_OAUTH_CLIENT_ID: "cid",
  GMAIL_OAUTH_CLIENT_SECRET: "csecret",
  GMAIL_OAUTH_REFRESH_TOKEN: "rtoken",
} as unknown as Env;

const MSG: TriagedMsg = {
  id: "m1",
  from: "Maya Chen <maya@bigsoundlabel.com>",
  subject: "Campaign numbers for the rollout",
  snippet: "Can you send over the latest TikTok metrics before Friday?",
  tier: "action_required",
  reasons: [],
};

// Endpoints that MUST never be hit — any send/dispatch path.
const FORBIDDEN_FRAGMENTS = ["/send", "messages.send", "/drafts/send"];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetGoogleTokenCache();
});

// ---------------------------------------------------------------------------
// 1. buildReplyPrompt — PURE
// ---------------------------------------------------------------------------

describe("buildReplyPrompt (pure)", () => {
  it("returns the { system, messages } prompt shape", () => {
    const prompt = buildReplyPrompt(MSG);
    expect(typeof prompt.system).toBe("string");
    expect(prompt.system.length).toBeGreaterThan(0);
    expect(Array.isArray(prompt.messages)).toBe(true);
    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0].role).toBe("user");
  });

  it("embeds the message context (from / subject / snippet)", () => {
    const content = buildReplyPrompt(MSG).messages[0].content;
    expect(content).toContain(MSG.from);
    expect(content).toContain(MSG.subject);
    expect(content).toContain(MSG.snippet);
  });

  it("instructs a draft-in-Eric's-voice reply and never to invent facts", () => {
    const { system } = buildReplyPrompt(MSG);
    expect(system).toMatch(/Eric/);
    expect(system.toLowerCase()).toContain("never invent");
  });

  it("is pure — same input yields a deeply-equal prompt, no mutation", () => {
    const a = buildReplyPrompt(MSG);
    const b = buildReplyPrompt(MSG);
    expect(a).toEqual(b);
  });

  it("tolerates missing fields without throwing", () => {
    const sparse = { id: "x", from: "", subject: "", snippet: "" } as TriagedMsg;
    expect(() => buildReplyPrompt(sparse)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. composeReplyDraft — shared callClaude, Re: subject derivation
// ---------------------------------------------------------------------------

describe("composeReplyDraft", () => {
  it("returns { to, subject, body } from the mocked callClaude", async () => {
    const spy = vi.fn(async () =>
      jsonResponse({
        id: "msg_1",
        content: [{ type: "text", text: "Hey Maya — sending the TikTok numbers now." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 8 },
      }),
    );
    // @ts-expect-error overriding the global fetch for the duration of the test
    globalThis.fetch = spy;

    const draft = await composeReplyDraft(env, MSG);

    expect(draft.to).toBe(MSG.from);
    expect(draft.subject).toBe("Re: Campaign numbers for the rollout");
    expect(draft.body).toBe("Hey Maya — sending the TikTok numbers now.");

    // It went through the shared Anthropic primitive (callClaude → Messages API).
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("api.anthropic.com/v1/messages");
  });

  it("does not double a Re: prefix already on the subject", async () => {
    const spy = vi.fn(async () =>
      jsonResponse({
        id: "msg_2",
        content: [{ type: "text", text: "Thanks for the follow-up." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 4 },
      }),
    );
    // @ts-expect-error overriding the global fetch for the duration of the test
    globalThis.fetch = spy;

    const draft = await composeReplyDraft(env, {
      ...MSG,
      subject: "RE: already a reply",
    });
    expect(draft.subject).toBe("RE: already a reply");
  });

  it("NEVER calls a send endpoint while composing", async () => {
    const urls: string[] = [];
    const spy = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return jsonResponse({
        id: "msg_3",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    // @ts-expect-error overriding the global fetch for the duration of the test
    globalThis.fetch = spy;

    await composeReplyDraft(env, MSG);
    for (const url of urls) {
      for (const frag of FORBIDDEN_FRAGMENTS) {
        expect(url).not.toContain(frag);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. stageReplyDraft — DRAFT only, guarded 403, no send path
// ---------------------------------------------------------------------------

describe("stageReplyDraft", () => {
  const draft = {
    to: "maya@bigsoundlabel.com",
    subject: "Re: Campaign numbers for the rollout",
    body: "Hey Maya — sending the numbers now.",
  };

  it("creates a Gmail DRAFT (drafts.create) and never hits a send endpoint", async () => {
    const urls: string[] = [];
    const methods: string[] = [];
    const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      methods.push((init?.method ?? "GET").toUpperCase());
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "at", expires_in: 3600 });
      }
      if (url.endsWith("/drafts")) {
        return jsonResponse({ id: "draft_1", message: { id: "m_1" } });
      }
      return jsonResponse({}, 404);
    });
    // @ts-expect-error overriding the global fetch for the duration of the test
    globalThis.fetch = spy;

    const result = await stageReplyDraft(env, draft);
    expect(result.staged).toBe(true);

    // Exactly one write, to drafts.create (POST /drafts).
    const draftCall = urls.findIndex((u) => u.endsWith("/drafts"));
    expect(draftCall).toBeGreaterThanOrEqual(0);
    expect(methods[draftCall]).toBe("POST");

    // The security-critical invariant: NO send endpoint, ever.
    for (const url of urls) {
      for (const frag of FORBIDDEN_FRAGMENTS) {
        expect(url).not.toContain(frag);
      }
    }
  });

  it("returns needs-scope on a 403 (read-only token) without throwing", async () => {
    const urls: string[] = [];
    const spy = vi.fn(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "at", expires_in: 3600 });
      }
      if (url.endsWith("/drafts")) {
        return new Response("insufficient scopes", { status: 403 });
      }
      return jsonResponse({}, 404);
    });
    // @ts-expect-error overriding the global fetch for the duration of the test
    globalThis.fetch = spy;

    const result = await stageReplyDraft(env, draft);
    expect(result.staged).toBe(false);
    expect(result.reason).toBe("needs gmail.compose scope");

    // Even on the failure path, no send endpoint was attempted.
    for (const url of urls) {
      for (const frag of FORBIDDEN_FRAGMENTS) {
        expect(url).not.toContain(frag);
      }
    }
  });

  it("stages FROM Eric's reviewed mailbox (REPLY_FROM)", async () => {
    let sentBody = "";
    const spy = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "at", expires_in: 3600 });
      }
      if (url.endsWith("/drafts")) {
        sentBody = String(init?.body ?? "");
        return jsonResponse({ id: "draft_2" });
      }
      return jsonResponse({}, 404);
    });
    // @ts-expect-error overriding the global fetch for the duration of the test
    globalThis.fetch = spy;

    await stageReplyDraft(env, draft);
    // The raw MIME (base64url) decodes to a message whose From is REPLY_FROM.
    const parsed = JSON.parse(sentBody) as { message: { raw: string } };
    const raw = parsed.message.raw.replace(/-/g, "+").replace(/_/g, "/");
    const mime = atob(raw);
    expect(mime).toContain(`From: ${REPLY_FROM}`);
  });
});

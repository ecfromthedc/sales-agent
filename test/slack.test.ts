import { describe, it, expect, vi } from "vitest";
import {
  notifySlack,
  buildBriefMessage,
  buildPitchMessage,
  briefToSlackMrkdwn,
  type FetchLike,
} from "../src/integrations/slack";
import type { Env } from "../src/lib/env";

// A minimal Env with just the Slack fields the helper reads. The rest are
// irrelevant to notifySlack, so we cast through unknown.
function envWith(partial: Partial<Env>): Env {
  return partial as unknown as Env;
}

// A fetch stub that records the last call and returns a canned Slack response.
function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: Parameters<FetchLike>[1] }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.body,
    };
  };
  return { fetchImpl, calls };
}

describe("notifySlack — guards (no-op without throwing)", () => {
  it("no-ops when the bot token is missing", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true, status: 200, body: { ok: true } });
    const res = await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "" }),
      "C123",
      { text: "hi" },
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, skipped: true });
    expect(calls).toHaveLength(0); // never hit the network
  });

  it("no-ops when the channel id is missing", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true, status: 200, body: { ok: true } });
    const res = await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "xoxb-test" }),
      undefined,
      { text: "hi" },
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, skipped: true });
    expect(calls).toHaveLength(0);
  });

  it("no-ops when the message text is empty", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true, status: 200, body: { ok: true } });
    const res = await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "xoxb-test" }),
      "C123",
      { text: "   " },
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, skipped: true });
    expect(calls).toHaveLength(0);
  });
});

describe("notifySlack — send path", () => {
  it("posts to chat.postMessage with bearer auth and channel", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true, status: 200, body: { ok: true } });
    const res = await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "xoxb-test" }),
      "C123",
      { text: "hello", blocks: [{ type: "section" }] },
      fetchImpl,
    );
    expect(res).toEqual({ ok: true, skipped: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://slack.com/api/chat.postMessage");
    expect(calls[0].init?.headers?.authorization).toBe("Bearer xoxb-test");
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("hello");
    expect(body.blocks).toEqual([{ type: "section" }]);
  });

  it("omits blocks when none are provided", async () => {
    const { fetchImpl, calls } = stubFetch({ ok: true, status: 200, body: { ok: true } });
    await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "xoxb-test" }),
      "C123",
      { text: "hello" },
      fetchImpl,
    );
    const body = JSON.parse(calls[0].init?.body ?? "{}");
    expect(body).not.toHaveProperty("blocks");
  });

  it("returns the Slack error code on a logical failure (HTTP 200, ok:false)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = stubFetch({ ok: true, status: 200, body: { ok: false, error: "channel_not_found" } });
    const res = await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "xoxb-test" }),
      "C123",
      { text: "hello" },
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, skipped: false, error: "channel_not_found" });
    warn.mockRestore();
  });

  it("never throws when fetch rejects (network failure is swallowed)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl: FetchLike = async () => {
      throw new Error("boom");
    };
    const res = await notifySlack(
      envWith({ SLACK_BOT_TOKEN: "xoxb-test" }),
      "C123",
      { text: "hello" },
      fetchImpl,
    );
    expect(res).toEqual({ ok: false, skipped: false, error: "boom" });
    warn.mockRestore();
  });
});

describe("briefToSlackMrkdwn", () => {
  it("converts bold, line-leading headings, and table pipes", () => {
    const out = briefToSlackMrkdwn("**Bold** text\n### Heading | col");
    expect(out).toContain("*Bold*");
    expect(out).toContain("*Heading"); // ### at line start → *
    expect(out).toContain("│"); //        pipe → unicode
    expect(out).not.toContain("**");
  });

  it("clamps to the Slack section limit", () => {
    const out = briefToSlackMrkdwn("x".repeat(5000));
    expect(out.length).toBe(2900);
  });
});

describe("buildBriefMessage", () => {
  const input = {
    inviteeName: "Jane Artist",
    inviteeEmail: "jane@label.com",
    inviteePhone: "+1 202 555 0142",
    meetingTime: "Mon, Jun 8, 3:00 PM",
    spotifyLink: "https://open.spotify.com/artist/example",
    hostSlackUserId: "U123",
    brief: "**Summary** of the call",
    pageId: "3611465b-b829-81de-a237-cf6516fe8fcf",
  };

  it("mentions the host and makes contact details prominent", () => {
    const msg = buildBriefMessage(input);
    expect(msg.text).toContain("<@U123>");
    expect(msg.text).toContain("jane@label.com");
    expect(msg.blocks?.[0]).toMatchObject({ type: "header" });
    expect(msg.blocks?.[1]).toMatchObject({ type: "section" });
    expect(msg.blocks?.[2]).toMatchObject({ type: "section" });
    expect(msg.blocks?.[3]).toMatchObject({ type: "context" });
  });

  it("links a de-hyphenated Notion url", () => {
    const ctx = buildBriefMessage(input).blocks?.[3] as {
      elements: Array<{ text: string }>;
    };
    expect(ctx.elements[0].text).toContain(
      "https://www.notion.so/3611465bb82981dea237cf6516fe8fcf",
    );
  });

  it("shows email, phone, Spotify, and owner in the contact card", () => {
    const contact = buildBriefMessage(input).blocks?.[1] as {
      fields: Array<{ text: string }>;
    };
    const text = contact.fields.map((field) => field.text).join("\n");
    expect(text).toContain("mailto:jane@label.com");
    expect(text).toContain("+1 202 555 0142");
    expect(text).toContain("https://open.spotify.com/artist/example");
    expect(text).toContain("<@U123>");
  });

  it("renders the brief through the mrkdwn transform", () => {
    const section = buildBriefMessage(input).blocks?.[2] as {
      text: { text: string };
    };
    expect(section.text.text).toContain("*Summary*");
    expect(section.text.text).not.toContain("**Summary**");
  });
});

describe("buildPitchMessage", () => {
  const base = {
    dealId: "deal-123",
    meetingTitle: "Strategy Session",
    quotedLines: 3,
    draftStaged: true,
  };

  it("states the quoted-moment count and draft status, factual + no secrets", () => {
    const msg = buildPitchMessage(base);
    expect(msg.text).toBe("🎯 Pitch ready — Strategy Session");
    const section = msg.blocks?.[1] as { text: { text: string } };
    expect(section.text.text).toContain("*3* transcript moments quoted");
    expect(section.text.text).toContain("Gmail *draft*");
  });

  it("singularizes a single quoted moment", () => {
    const section = buildPitchMessage({ ...base, quotedLines: 1 }).blocks?.[1] as {
      text: { text: string };
    };
    expect(section.text.text).toContain("*1* transcript moment quoted");
    expect(section.text.text).not.toContain("moments");
  });

  it("notes when no follow-up draft was staged", () => {
    const section = buildPitchMessage({ ...base, draftStaged: false }).blocks?.[1] as {
      text: { text: string };
    };
    expect(section.text.text).toContain("No follow-up draft staged");
  });

  it("falls back to a generic title when meetingTitle is absent", () => {
    const msg = buildPitchMessage({ ...base, meetingTitle: undefined });
    expect(msg.text).toBe("🎯 Pitch ready — Post-call pitch");
  });

  it("links the de-hyphenated deal page in Notion", () => {
    const ctx = buildPitchMessage({
      ...base,
      dealId: "3611465b-b829-81de-a237-cf6516fe8fcf",
    }).blocks?.[2] as { elements: Array<{ text: string }> };
    expect(ctx.elements[0].text).toContain(
      "https://www.notion.so/3611465bb82981dea237cf6516fe8fcf",
    );
  });

  it("exposes a Draft Proposal action carrying the deal id (proposal pipeline entry point)", () => {
    const actions = buildPitchMessage({ ...base, dealId: "deal-xyz" }).blocks?.[3] as {
      type: string;
      elements: Array<{ action_id?: string; value?: string; url?: string }>;
    };
    expect(actions.type).toBe("actions");
    const draftBtn = actions.elements.find((e) => e.action_id === "draft_proposal");
    expect(draftBtn).toBeDefined();
    // slack-interactions reads action.value as the deal id — must round-trip exactly.
    expect(draftBtn?.value).toBe("deal-xyz");
  });
});

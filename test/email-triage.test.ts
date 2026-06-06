import { describe, it, expect } from "vitest";
import { classifyEmail } from "../src/roles/email/triage";
import type { EmailInput } from "../src/roles/email/triage";

const base: EmailInput = { from: "", subject: "", snippet: "" };

describe("classifyEmail — skip tier (automated noise)", () => {
  it("classifies a noreply sender with no actionable content as skip", () => {
    const r = classifyEmail({
      from: "GitHub <noreply@github.com>",
      subject: "Your build status",
      snippet: "The build completed.",
    });
    expect(r.tier).toBe("skip");
    expect(r.reasons.some((x) => x.includes("automated sender"))).toBe(true);
  });

  it("treats no-reply / donotreply / notifications variants as automated", () => {
    for (const addr of [
      "no-reply@x.com",
      "donotreply@x.com",
      "do-not-reply@x.com",
      "notifications@x.com",
    ]) {
      const r = classifyEmail({ ...base, from: addr, subject: "ping", snippet: "auto" });
      expect(r.tier).toBe("skip");
    }
  });

  it("mailer-daemon bounce is skip", () => {
    const r = classifyEmail({
      from: "mailer-daemon@mail.example.com",
      subject: "Delivery Status Notification (Failure)",
      snippet: "Address not found",
    });
    expect(r.tier).toBe("skip");
  });
});

describe("classifyEmail — info_only tier (FYI / bulk)", () => {
  it("classifies a newsletter as info_only", () => {
    const r = classifyEmail({
      from: "The Hustle <team@thehustle.co>",
      subject: "Your weekly digest is here",
      snippet: "This week in tech... view in browser to read more.",
    });
    expect(r.tier).toBe("info_only");
    expect(r.reasons.some((x) => x.includes("info/bulk keyword"))).toBe(true);
  });

  it("classifies a receipt as info_only", () => {
    const r = classifyEmail({
      from: "Stripe <receipts@stripe.com>",
      subject: "Your receipt from Rising Tides",
      snippet: "Thanks for your payment. Order confirmation #1234.",
    });
    expect(r.tier).toBe("info_only");
  });

  it("bulk List-Unsubscribe header alone routes to info_only", () => {
    const r = classifyEmail({
      from: "marketing@brand.com",
      subject: "Big spring update",
      snippet: "Lots happening at our company.",
      headers: { "List-Unsubscribe": "<mailto:unsub@brand.com>" },
    });
    expect(r.tier).toBe("info_only");
    expect(r.reasons.some((x) => x.includes("List-Unsubscribe"))).toBe(true);
  });

  it("Precedence: bulk header routes to info_only", () => {
    const r = classifyEmail({
      from: "updates@brand.com",
      subject: "Spring update",
      snippet: "News from us.",
      headers: { Precedence: "bulk" },
    });
    expect(r.tier).toBe("info_only");
    expect(r.reasons.some((x) => x.includes("Precedence: bulk"))).toBe(true);
  });

  it("a security alert from a noreply sender is info_only (not skip)", () => {
    const r = classifyEmail({
      from: "noreply@accounts.google.com",
      subject: "Security alert",
      snippet: "New login to your account from a new device.",
    });
    // info keyword promotes it above pure skip
    expect(r.tier).toBe("info_only");
  });
});

describe("classifyEmail — meeting_info tier (scheduling)", () => {
  it("classifies a Calendly invite as meeting_info", () => {
    const r = classifyEmail({
      from: "Calendly <notify@calendly.com>",
      subject: "New Event: Intro call",
      snippet: "A new event has been scheduled via Calendly.",
    });
    // calendly keyword present; not a pure noreply
    expect(r.tier).toBe("meeting_info");
    expect(r.reasons.some((x) => x.includes("meeting keyword"))).toBe(true);
  });

  it("classifies a calendar invitation as meeting_info", () => {
    const r = classifyEmail({
      from: "Jordan <jordan@label.com>",
      subject: "Invitation: Campaign sync @ Thu 3pm",
      snippet: "You have been invited to a calendar event.",
    });
    expect(r.tier).toBe("meeting_info");
  });

  it("'are you free' scheduling ask without a question mark is meeting_info or action_required", () => {
    const r = classifyEmail({
      from: "Sam <sam@indie.com>",
      subject: "Quick sync",
      snippet: "Are you free Tuesday to set up a call about the release?",
    });
    // contains a question mark AND scheduling words; both are human-ask signals.
    expect(["meeting_info", "action_required"]).toContain(r.tier);
    expect(r.reasons.some((x) => x.includes("meeting keyword"))).toBe(true);
  });

  it("a pure noreply scheduling notification is NOT promoted to meeting_info", () => {
    const r = classifyEmail({
      from: "noreply@calendar-system.com",
      subject: "Reminder: meeting tomorrow",
      snippet: "This is an automated reminder.",
    });
    // noreply sender blocks meeting_info promotion -> falls to info_only/skip
    expect(r.tier).not.toBe("meeting_info");
  });
});

describe("classifyEmail — action_required tier (human asks)", () => {
  it("classifies a direct question as action_required", () => {
    const r = classifyEmail({
      from: "Maya <maya@label.com>",
      subject: "Campaign numbers",
      snippet: "Can you send over the latest TikTok metrics for the rollout?",
    });
    expect(r.tier).toBe("action_required");
    expect(r.reasons.some((x) => x.includes("action keyword"))).toBe(true);
  });

  it("classifies a thread reply (Re:) as action_required", () => {
    const r = classifyEmail({
      from: "Chris <chris@artist.com>",
      subject: "Re: Pricing",
      snippet: "Sounds good, when can we lock this in.",
      headers: { "In-Reply-To": "<abc@mail.com>" },
    });
    expect(r.tier).toBe("action_required");
    expect(r.reasons.some((x) => x.includes("reply in an existing thread"))).toBe(true);
  });

  it("a 'please' personal ask is action_required", () => {
    const r = classifyEmail({
      from: "Pat <pat@studio.com>",
      subject: "Deck",
      snippet: "Please review the attached deck before our chat.",
    });
    expect(r.tier).toBe("action_required");
  });

  it("a plain question mark from a real person is action_required", () => {
    const r = classifyEmail({
      from: "Lee <lee@gmail.com>",
      subject: "Availability",
      snippet: "Did the contract go through on your end?",
    });
    expect(r.tier).toBe("action_required");
    expect(r.reasons.some((x) => x.includes("contains a question"))).toBe(true);
  });
});

describe("classifyEmail — precedence: human ask beats bulk noise is blocked", () => {
  it("an automated sender asking a question does NOT become action_required", () => {
    const r = classifyEmail({
      from: "noreply@survey.com",
      subject: "How did we do?",
      snippet: "Can you rate your experience? Click here.",
      headers: { "List-Unsubscribe": "<mailto:u@survey.com>" },
    });
    // bulk sender + headers block the action_required promotion
    expect(r.tier).not.toBe("action_required");
    expect(["info_only", "skip"]).toContain(r.tier);
  });

  it("meeting keyword + question from a real person resolves to action_required", () => {
    const r = classifyEmail({
      from: "Robin <robin@label.com>",
      subject: "Re: Schedule a call",
      snippet: "Can you find a time this week to hop on a call?",
      headers: { References: "<thread@mail.com>" },
    });
    // human-ask precedence wins over meeting_info
    expect(r.tier).toBe("action_required");
  });
});

describe("classifyEmail — edge cases & determinism", () => {
  it("empty input does not throw and returns a valid tier", () => {
    const r = classifyEmail({ from: "", subject: "", snippet: "" });
    expect(["skip", "info_only", "meeting_info", "action_required"]).toContain(r.tier);
    // nothing actionable, no automated marker -> safe default
    expect(r.tier).toBe("info_only");
  });

  it("missing headers field is tolerated", () => {
    const r = classifyEmail({
      from: "x@y.com",
      subject: "hi",
      snippet: "hello there",
    });
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it("ambiguous plain mail with no strong signal defaults to info_only", () => {
    const r = classifyEmail({
      from: "Dana <dana@company.com>",
      subject: "FYI",
      snippet: "Sharing this for your awareness.",
    });
    expect(r.tier).toBe("info_only");
  });

  it("header lookup is case-insensitive", () => {
    const r = classifyEmail({
      from: "x@y.com",
      subject: "update",
      snippet: "news",
      headers: { "list-unsubscribe": "<mailto:u@y.com>" },
    });
    expect(r.reasons.some((x) => x.includes("List-Unsubscribe"))).toBe(true);
    expect(r.tier).toBe("info_only");
  });

  it("returns ALL matched reasons, not just the first", () => {
    const r = classifyEmail({
      from: "Sam <sam@indie.com>",
      subject: "Re: Are you free?",
      snippet: "Can you please confirm a meeting time? Thoughts?",
      headers: { "In-Reply-To": "<t@mail.com>" },
    });
    // expect multiple distinct signals captured
    expect(r.reasons.length).toBeGreaterThanOrEqual(4);
    expect(r.reasons.some((x) => x.includes("action keyword"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("meeting keyword"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("contains a question"))).toBe(true);
    expect(r.reasons.some((x) => x.includes("reply in an existing thread"))).toBe(true);
  });

  it("is deterministic — same input yields identical output", () => {
    const input: EmailInput = {
      from: "Maya <maya@label.com>",
      subject: "Re: numbers",
      snippet: "Can you send the metrics?",
      headers: { References: "<t@mail.com>" },
    };
    const a = classifyEmail(input);
    const b = classifyEmail(input);
    expect(a).toEqual(b);
  });

  it("attaches a numeric score for transparency", () => {
    const r = classifyEmail({
      from: "Maya <maya@label.com>",
      subject: "Question",
      snippet: "Can you please confirm?",
    });
    expect(typeof r.score).toBe("number");
    expect(r.score).toBeGreaterThan(0);
  });

  it("extracts the address from a display-name From header", () => {
    const r = classifyEmail({
      from: '"Notifications Team" <noreply@service.io>',
      subject: "update",
      snippet: "automated message",
    });
    expect(r.tier).toBe("skip");
    expect(r.reasons.some((x) => x.includes("automated sender"))).toBe(true);
  });
});

/**
 * src/roles/email/reply.ts — compose an outbound reply DRAFT for an
 * `action_required` inbox message, behind a human approval gate.
 *
 * SAFETY — NEVER SEND (SALE-120):
 *   This module composes a reply and stages it as a Gmail DRAFT only. There is
 *   deliberately NO send path anywhere in here: it does not import, reference,
 *   or call `users.messages.send`, `drafts.send`, or any other dispatch
 *   endpoint. A human (Eric) reviews every draft in Gmail and presses send.
 *   The ONLY write performed is `users.drafts.create` (via
 *   {@link createGmailDraft} in ../../integrations/gmail.ts — SALE-63), which
 *   creates a draft and never dispatches it.
 *
 * Reuse:
 *   - `callClaude` — THE shared Anthropic Messages-API primitive, imported via
 *     the `src/shared` barrel (SALE-104/109). The reply text is generated here.
 *   - `createGmailDraft` — THE shared Gmail draft creator (SALE-63). The staged
 *     draft is created here. Both are single sources of truth; this module adds
 *     no second Claude call site and no second Gmail write site.
 */

import type { Env } from "../../lib/env";
// SALE-109: pull the shared Claude primitive through the cross-role barrel.
import { callClaude } from "../../shared";
// SALE-124: extractText is the single shared Claude text-extraction helper,
// owned by lib/anthropic alongside callClaude. Imported directly (it is not on
// the src/shared barrel, whose surface is locked to the core primitives).
import { extractText } from "../../lib/anthropic";
// Draft-only Gmail write (SALE-63). NOTE: there is intentionally NO send import
// here — `createGmailDraft` is the only Gmail-write primitive this module ever
// touches, and it calls `users.drafts.create` exclusively.
import { createGmailDraft } from "../../integrations/gmail";
import type { TriagedMsg } from "./inbox";

// Sonnet: fast, good tone for short professional replies (per RT CLAUDE.md).
const MODEL_REPLY = "claude-sonnet-4-6";

/**
 * The address Henry stages reply drafts FROM. The draft lands in this mailbox's
 * Drafts folder for human review; it is never auto-dispatched.
 */
export const REPLY_FROM = "Eric Cromartie <ec@risingtidesent.com>";

/** The composed reply draft fields (no `from` — the stager supplies it). */
export interface ReplyDraft {
  to: string;
  subject: string;
  body: string;
}

/** Result of staging a draft: whether it was created, and why not if it wasn't. */
export interface StageReplyResult {
  staged: boolean;
  reason?: string;
}

/** The prompt shape `callClaude` consumes (system + messages). */
export interface ReplyPrompt {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

const REPLY_SYSTEM = `You draft email REPLIES for Eric Cromartie, founder of Rising Tides (a music-marketing agency). Eric reviews every draft before it is sent — you are writing a draft, never sending.

Voice rules — non-negotiable:
- Short, warm, direct. Open with "Hey [First Name]," when you can infer a first name from the sender; otherwise "Hey,".
- 2-5 sentences. Get to the point. Eric does not write essays.
- Reference something specific from the message you're replying to so it reads like a real human reply, not a template.
- State facts; skip hedging. Never invent metrics, clients, campaigns, dates, or commitments — only respond to what's actually in the message.
- No corporate AI slop: no "leverage", "synergy", "circle back", "landscape", "ecosystem", "game-changer", "deep dive", "elevate".
- Plain text only. No subject line in the body, no signature block — just the reply body.

Output ONLY the reply body text. No preamble, no quotes around it, no "Here's a draft:".`;

/**
 * PURE. Build the prompt that asks Claude to draft a concise, professional
 * reply (in Eric's voice) to an `action_required` message. No I/O, no network —
 * same input → same output, trivially unit-testable.
 *
 * The message context (from / subject / snippet) is embedded in the user turn
 * so the reply can reference specifics from the original mail.
 */
export function buildReplyPrompt(msg: TriagedMsg): ReplyPrompt {
  const from = msg?.from ?? "";
  const subject = msg?.subject ?? "";
  const snippet = msg?.snippet ?? "";

  const content = [
    "Draft a reply to this email. Respond only to what it actually says.",
    "",
    `From: ${from}`,
    `Subject: ${subject}`,
    `Message: ${snippet}`,
  ].join("\n");

  return {
    system: REPLY_SYSTEM,
    messages: [{ role: "user", content }],
  };
}

/** Derive a `Re:` subject without doubling an existing `Re:` prefix. */
function toReplySubject(subject: string): string {
  const s = (subject ?? "").trim();
  if (s.length === 0) return "Re:";
  if (/^re:/i.test(s)) return s;
  return `Re: ${s}`;
}

/**
 * Compose a reply DRAFT for an `action_required` message. Calls the SHARED
 * {@link callClaude} with {@link buildReplyPrompt} and returns the draft fields.
 *
 * Reply only — there is no send path. The returned object is a draft for a human
 * to review (and, separately, to stage via {@link stageReplyDraft}).
 *
 * @returns `{ to, subject, body }` — `to` is the original sender, `subject` is a
 *   `Re:`-prefixed derivation of the original subject, `body` is the model text.
 */
export async function composeReplyDraft(
  env: Env,
  msg: TriagedMsg,
): Promise<ReplyDraft> {
  const { system, messages } = buildReplyPrompt(msg);

  const res = await callClaude(env, {
    model: MODEL_REPLY,
    maxTokens: 1024,
    system,
    messages,
  });

  return {
    to: msg.from,
    subject: toReplySubject(msg.subject),
    // Trim here (not in the shared helper) so reply bodies stay whitespace-clean
    // without changing the lib callers (composeBrief/Pitch/Proposal) that rely
    // on the untrimmed text. Preserves SALE-124's pre-dedupe behavior exactly.
    body: extractText(res).trim(),
  };
}

/**
 * Stage a composed reply as a Gmail DRAFT (NEVER send). Delegates to the shared
 * {@link createGmailDraft}, which calls `users.drafts.create` only.
 *
 * SCOPE REQUIREMENT — IMPORTANT:
 *   The shared `GMAIL_OAUTH_REFRESH_TOKEN` is minted with `gmail.readonly` +
 *   `drive.readonly`. `users.drafts.create` needs a WRITE scope, so this call
 *   will 403 until the refresh token is re-minted with `gmail.compose` (or
 *   `gmail.modify`). We GUARD that here: the failure is caught and surfaced as
 *   `{ staged: false, reason: "needs gmail.compose scope" }` so a missing scope
 *   never throws into the inbox/triage flow. Re-mint via the same OAuth consent
 *   flow used elsewhere, adding:
 *     https://www.googleapis.com/auth/gmail.compose
 *
 * No send endpoint is ever called here — staging means `drafts.create`, full
 * stop.
 */
export async function stageReplyDraft(
  env: Env,
  draft: ReplyDraft,
): Promise<StageReplyResult> {
  try {
    await createGmailDraft(env, {
      to: draft.to,
      from: REPLY_FROM,
      subject: draft.subject,
      body: draft.body,
    });
    return { staged: true };
  } catch (err) {
    // A 403 here means the OAuth token is still read-only scoped (no
    // gmail.compose). Surface it as a soft, actionable reason instead of
    // throwing — the approval-gate flow must never crash on a missing scope.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("403")) {
      return { staged: false, reason: "needs gmail.compose scope" };
    }
    // Any other failure (network, 5xx, malformed response) is also reported
    // softly so a transient Gmail error can't sink the surrounding flow.
    return { staged: false, reason: message };
  }
}

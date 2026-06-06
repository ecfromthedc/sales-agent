/**
 * src/roles/email/triage.ts — pure 4-tier Gmail triage classifier.
 *
 * PURE + DETERMINISTIC: no I/O, no network, no Node APIs. Same input → same
 * output. Workers-compatible. This is the decision core of the EMAIL role;
 * future tickets wire it to a real Gmail surface (read / label / draft).
 *
 * Tiers (mutually exclusive, chosen by a precedence ladder):
 *   - skip            : pure noise (automated no-reply / bulk-list senders)
 *   - info_only       : FYI mail (newsletters, digests, receipts, alerts)
 *   - meeting_info    : scheduling signals (invites, Calendly, "are you free?")
 *   - action_required : needs a human reply (questions, personal asks, replies)
 *
 * SALE-117: scaffold the email role with a tested pure classifier. No sending.
 */

export type EmailTier = "skip" | "info_only" | "meeting_info" | "action_required";

export interface EmailInput {
  from: string;
  subject: string;
  snippet: string;
  headers?: Record<string, string>;
}

export interface EmailClassification {
  tier: EmailTier;
  /** ALL matched rules, in evaluation order — for transparency / audit. */
  reasons: string[];
  /** Internal action-likelihood signal (higher = more likely to need a reply). */
  score: number;
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** Case-insensitive lookup over an arbitrary-cased header map. */
function getHeader(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return "";
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) {
      const v = headers[key];
      return typeof v === "string" ? v : "";
    }
  }
  return "";
}

/** Extract the bare email address (lowercased) from a `from` header value. */
function extractAddress(from: string): string {
  const lower = (from ?? "").toLowerCase();
  const angled = lower.match(/<([^>]+)>/);
  const raw = angled ? angled[1] : lower;
  // grab the first token that looks like an address
  const at = raw.match(/[^\s<>:;,"']+@[^\s<>:;,"']+/);
  return (at ? at[0] : raw).trim();
}

function hasAny(haystack: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const n of needles) {
    if (haystack.includes(n)) hits.push(n);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Rule vocabularies
// ---------------------------------------------------------------------------

// Local-part / address fragments that mark an automated, unmonitored sender.
const NOREPLY_SENDER_FRAGMENTS = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "notification",
  "notifications",
  "mailer-daemon",
  "automated",
  "bounce",
];

// Subject/snippet markers of FYI / bulk content.
const INFO_KEYWORDS = [
  "newsletter",
  "digest",
  "weekly roundup",
  "daily roundup",
  "receipt",
  "invoice",
  "order confirmation",
  "your order",
  "shipping",
  "tracking number",
  "statement",
  "unsubscribe",
  "view in browser",
  "you're receiving this",
  "youre receiving this",
  "new login",
  "security alert",
  "sign-in",
  "verification code",
  "promo",
  "sale ends",
];

// Scheduling / meeting markers.
const MEETING_KEYWORDS = [
  "meeting",
  "calendar invite",
  "calendar",
  "invite",
  "invitation:",
  "calendly",
  "zoom.us/j/",
  "google meet",
  "meet.google.com",
  "are you free",
  "are you available",
  "schedule a call",
  "scheduling",
  "book a time",
  "find a time",
  "set up a call",
  "hop on a call",
  "grab time",
  "available to chat",
  "when works for you",
  "what time works",
  "reschedule",
  "rsvp",
];

// Direct, actionable asks (a human is being asked to do/answer something).
const ACTION_KEYWORDS = [
  "can you",
  "could you",
  "would you",
  "please",
  "let me know",
  "thoughts?",
  "your thoughts",
  "what do you think",
  "any update",
  "following up",
  "follow up",
  "quick question",
  "need your",
  "waiting on",
  "get back to me",
  "circle back",
  "action required",
  "action needed",
  "respond by",
  "asap",
];

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single email into one of four triage tiers.
 *
 * Precedence ladder (highest tier wins, but automated-noise demotion can pull
 * an otherwise-actionable-looking machine email back down):
 *   1. Gather signals from sender, headers, subject, snippet.
 *   2. action_required if a genuine human ask is present AND the sender is not
 *      a pure automated noreply/bulk source.
 *   3. meeting_info if scheduling signals are present (and not pure noise).
 *   4. info_only if it's identifiable FYI/bulk content.
 *   5. skip if it's automated noise with nothing actionable.
 *   6. info_only as the safe default for anything unclassified (never silently
 *      drop a real human email into `skip`).
 */
export function classifyEmail(input: EmailInput): EmailClassification {
  const from = input?.from ?? "";
  const subject = input?.subject ?? "";
  const snippet = input?.snippet ?? "";
  const headers = input?.headers;

  const address = extractAddress(from);
  const haystack = `${subject}\n${snippet}`.toLowerCase();

  const reasons: string[] = [];

  // --- Automated / bulk sender signals -------------------------------------
  const noreplyHits = NOREPLY_SENDER_FRAGMENTS.filter((f) => address.includes(f));
  const isNoreplySender = noreplyHits.length > 0;
  if (isNoreplySender) {
    reasons.push(`automated sender (${noreplyHits.join(", ")})`);
  }

  const listUnsub = getHeader(headers, "List-Unsubscribe");
  const listId = getHeader(headers, "List-Id");
  const precedence = getHeader(headers, "Precedence").toLowerCase();
  const autoSubmitted = getHeader(headers, "Auto-Submitted").toLowerCase();

  const hasBulkHeaders =
    listUnsub.length > 0 ||
    listId.length > 0 ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk" ||
    (autoSubmitted.length > 0 && autoSubmitted !== "no");

  if (listUnsub) reasons.push("List-Unsubscribe header present");
  if (listId) reasons.push("List-Id header present");
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    reasons.push(`Precedence: ${precedence}`);
  }
  if (autoSubmitted.length > 0 && autoSubmitted !== "no") {
    reasons.push(`Auto-Submitted: ${autoSubmitted}`);
  }

  const isBulk = isNoreplySender || hasBulkHeaders;

  // --- Content signals ------------------------------------------------------
  const infoHits = hasAny(haystack, INFO_KEYWORDS);
  if (infoHits.length > 0) {
    reasons.push(`info/bulk keyword (${infoHits.join(", ")})`);
  }

  const meetingHits = hasAny(haystack, MEETING_KEYWORDS);
  if (meetingHits.length > 0) {
    reasons.push(`meeting keyword (${meetingHits.join(", ")})`);
  }

  const actionHits = hasAny(haystack, ACTION_KEYWORDS);
  if (actionHits.length > 0) {
    reasons.push(`action keyword (${actionHits.join(", ")})`);
  }

  const hasQuestion = haystack.includes("?");
  if (hasQuestion) reasons.push("contains a question");

  // Reply in an existing thread → almost always a human continuing a convo.
  const subjLower = subject.toLowerCase();
  const inReplyTo = getHeader(headers, "In-Reply-To");
  const references = getHeader(headers, "References");
  const isThreadReply =
    subjLower.startsWith("re:") || inReplyTo.length > 0 || references.length > 0;
  if (isThreadReply) reasons.push("reply in an existing thread");

  // --- Score (transparency signal, not the sole decider) -------------------
  let score = 0;
  score += actionHits.length * 2;
  if (hasQuestion) score += 2;
  if (isThreadReply) score += 2;
  score += meetingHits.length;
  score -= infoHits.length;
  if (isBulk) score -= 3;

  // A genuine human ask: an explicit ask keyword, OR a question, OR a
  // continuing thread reply — provided it isn't pure automated noise.
  const hasHumanAsk = actionHits.length > 0 || hasQuestion || isThreadReply;

  // --- Precedence ladder ----------------------------------------------------
  let tier: EmailTier;

  if (hasHumanAsk && !isBulk) {
    // Direct ask from a real person → needs a (human-approved) reply.
    tier = "action_required";
    reasons.push("-> action_required: human ask from a non-automated sender");
  } else if (meetingHits.length > 0 && !isNoreplySender) {
    // Scheduling signal. Allow bulk-header invites (calendar systems send
    // List headers) but not pure noreply spam.
    tier = "meeting_info";
    reasons.push("-> meeting_info: scheduling signal present");
  } else if (infoHits.length > 0 || hasBulkHeaders) {
    // Identifiable FYI/bulk content → keep but de-prioritize.
    tier = "info_only";
    reasons.push("-> info_only: FYI / bulk content");
  } else if (isNoreplySender) {
    // Automated sender with nothing actionable → pure noise.
    tier = "skip";
    reasons.push("-> skip: automated sender, no actionable content");
  } else {
    // Unclassified human-ish mail → safe default, never silently skip.
    tier = "info_only";
    reasons.push("-> info_only: default (no strong signal)");
  }

  return { tier, reasons, score };
}

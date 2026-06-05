// Canonical pitch-deck section template.
//
// The post-call pitch deck is composed by Claude (see lib/anthropic.ts
// `composePitch`) and rendered to a Swiss-grid PDF (see integrations/pdf.ts).
// Historically the deck HTML was free-form, so two decks for two prospects
// could have wildly different structures. This module pins down the canonical,
// ordered set of sections every deck must contain, plus a pure helper that
// normalizes whatever the model returns into that exact order.
//
// Kept dependency-free and side-effect-free so it's trivially unit-testable
// and Workers-compatible.

/** Stable machine id for a deck section. Order in this union is not load-bearing;
 *  `PITCH_SECTIONS` defines the canonical order. */
export type PitchSectionId =
  | "cover"
  | "opportunity"
  | "whatWeHeard"
  | "proposedCampaign"
  | "creatorsReach"
  | "timeline"
  | "investment"
  | "nextSteps";

export interface PitchSectionSpec {
  /** Stable id used as the JSON key the model fills and the render anchor. */
  id: PitchSectionId;
  /** Human-facing heading rendered on the slide. */
  title: string;
  /** One-line instruction handed to the model describing what belongs here. */
  prompt: string;
}

/**
 * The canonical, ordered pitch-deck sections.
 *
 * Order matters: this is the slide order in the rendered deck and the order
 * `orderSections` will emit. Derived from the existing pitch flow — a Rising
 * Tides post-call deck opens with a cover, frames the opportunity, mirrors the
 * prospect's own words back ("what we heard" — ties to the ≥3 quoted transcript
 * lines), proposes the campaign, then lands creators/reach, timeline,
 * investment, and next steps.
 */
export const PITCH_SECTIONS: readonly PitchSectionSpec[] = [
  {
    id: "cover",
    title: "Cover",
    prompt:
      "Artist/label name, the one-line value prop, and the call date. No fluff.",
  },
  {
    id: "opportunity",
    title: "The Opportunity",
    prompt:
      "Where this artist sits in the market right now and the specific opening RT can move on. Use only real numbers surfaced on the call.",
  },
  {
    id: "whatWeHeard",
    title: "What We Heard",
    prompt:
      "Mirror the prospect's own priorities back to them. Quote at least the strongest transcript moments verbatim. No invented quotes.",
  },
  {
    id: "proposedCampaign",
    title: "Proposed Campaign",
    prompt:
      "The concrete play: format, platforms, and the angle. Tie each element back to something they said.",
  },
  {
    id: "creatorsReach",
    title: "Creators & Reach",
    prompt:
      "Creator archetypes and realistic reach. Never fabricate creator names, follower counts, or guaranteed numbers.",
  },
  {
    id: "timeline",
    title: "Timeline",
    prompt:
      "Phased timeline anchored to their release window. Keep it feasible.",
  },
  {
    id: "investment",
    title: "Investment",
    prompt:
      "The ask, framed as value. Only state pricing if it was discussed on the call; otherwise frame the tier without inventing a figure.",
  },
  {
    id: "nextSteps",
    title: "Next Steps",
    prompt:
      "Clear, low-friction next action and who owns it. End on momentum, not a hard close.",
  },
] as const;

/** Ordered list of canonical section ids (single source of truth for order). */
export const PITCH_SECTION_IDS: readonly PitchSectionId[] = PITCH_SECTIONS.map(
  (s) => s.id,
);

/** A section as filled in by the model: id + rendered body. */
export interface FilledPitchSection {
  id: PitchSectionId;
  title: string;
  /** Model-authored body for this section (plain text or inline HTML). */
  body: string;
}

/** True when `id` is one of the canonical section ids. */
export function isPitchSectionId(id: unknown): id is PitchSectionId {
  return (
    typeof id === "string" &&
    PITCH_SECTION_IDS.includes(id as PitchSectionId)
  );
}

/**
 * Render the canonical sections into the prompt fragment handed to the model,
 * so Claude fills a defined structure instead of improvising one.
 */
export function sectionsPromptBlock(): string {
  return PITCH_SECTIONS.map(
    (s, i) => `${i + 1}. "${s.id}" (${s.title}) — ${s.prompt}`,
  ).join("\n");
}

/**
 * Normalize raw model output into the canonical section order.
 *
 * Accepts whatever the model returned for `sections` (an array of objects keyed
 * by `id`/`body`, in any order, possibly with extras or gaps) and returns every
 * canonical section exactly once, in `PITCH_SECTIONS` order. Missing sections
 * are emitted with an empty body so the deck structure is always complete;
 * unknown ids are dropped. Always returns the full, ordered set — never throws.
 */
export function orderSections(raw: unknown): FilledPitchSection[] {
  const byId = new Map<PitchSectionId, string>();

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      if (!isPitchSectionId(id)) continue;
      if (byId.has(id)) continue; // first occurrence wins
      const body = (entry as { body?: unknown }).body;
      byId.set(id, typeof body === "string" ? body.trim() : "");
    }
  }

  return PITCH_SECTIONS.map((spec) => ({
    id: spec.id,
    title: spec.title,
    body: byId.get(spec.id) ?? "",
  }));
}

/** Ids of canonical sections the model left empty (after `orderSections`). */
export function missingSections(
  sections: readonly FilledPitchSection[],
): PitchSectionId[] {
  const present = new Set(
    sections.filter((s) => s.body.trim().length > 0).map((s) => s.id),
  );
  return PITCH_SECTION_IDS.filter((id) => !present.has(id));
}

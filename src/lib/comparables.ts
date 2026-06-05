/**
 * Comparable-client matching for the pre-call brief.
 *
 * Given a prospect's signal (genres + a follower/listener tier) and a set of
 * RT past-campaign records, rank the most comparable past clients so the rep
 * can reference relevant proof on the call ("we ran a $25k campaign for an
 * artist just like you").
 *
 * Pure + deterministic — no I/O, no network, no `Date.now()` (callers pass an
 * explicit `asOf` reference date). This makes the scoring model fully
 * unit-testable and keeps the Workers hot path side-effect-free.
 *
 * ## Similarity model (0..1, higher = more comparable)
 *
 *   score = 0.50 * genreOverlap
 *         + 0.35 * tierProximity
 *         + 0.15 * recency
 *
 * Genre is weighted highest: a same-genre proof point is the most persuasive
 * thing Eric can cite. Tier proximity is next — an artist at a wildly
 * different audience size isn't a credible comparable even in the same genre.
 * Recency is the lightest tie-breaker — a recent win reads as "currently
 * doing this," but an older same-genre/same-tier campaign still counts.
 *
 * Each sub-score is normalized to 0..1:
 *
 *   - genreOverlap  — Jaccard similarity of the (case-folded) genre tag sets.
 *                     |A ∩ B| / |A ∪ B|. 1.0 = identical tags, 0.0 = disjoint.
 *                     If either side has no genre tags we can't claim genre
 *                     similarity, so it contributes 0.
 *
 *   - tierProximity — based on the gap between integer audience tiers (see
 *                     `audienceTier`). Same tier = 1.0, each tier of distance
 *                     subtracts 0.34, floored at 0. Missing audience data on
 *                     either side contributes 0 (we don't reward unknowns).
 *
 *   - recency       — linear decay over `RECENCY_HORIZON_DAYS`. A campaign
 *                     today scores 1.0; one at/after the horizon scores 0.
 *                     Missing/unparseable start date contributes 0.
 *
 * Deterministic tie-break (so ranking is stable): when two candidates score
 * equal within `SCORE_EPSILON`, the one with the more recent `startDate` wins;
 * if still equal, the lexicographically smaller `id` wins.
 */

/** Weights for the three similarity components. Sum to 1.0. */
export const GENRE_WEIGHT = 0.5;
export const TIER_WEIGHT = 0.35;
export const RECENCY_WEIGHT = 0.15;

/** Recency decays linearly to zero over this many days. */
export const RECENCY_HORIZON_DAYS = 730; // ~2 years

/** Per-tier penalty applied to tier proximity for each step of distance. */
export const TIER_STEP_PENALTY = 0.34;

/** Scores within this distance are treated as a tie for ranking purposes. */
export const SCORE_EPSILON = 1e-9;

/**
 * A candidate RT past client to compare the prospect against.
 *
 * This is intentionally decoupled from the Notion/CRM row shape so the scorer
 * stays pure and the (brittle) CRM property mapping lives elsewhere. Genres and
 * audience are optional because the CRM doesn't always carry them.
 */
export interface ComparableCandidate {
  /** Stable identifier (used as the final tie-break). */
  id: string;
  /** Display name for the brief. */
  artistName: string;
  /** Genre tags for this past client, if known. */
  genres?: string[];
  /** Audience size (monthly listeners or followers) for tier bucketing. */
  audience?: number | null;
  /** ISO date the campaign started, if known (drives recency + tie-break). */
  startDate?: string | null;
}

/** The prospect we're finding comparables for. */
export interface ProspectSignal {
  genres: string[];
  /** Audience size (monthly listeners preferred, else followers). */
  audience?: number | null;
}

/** A scored candidate, with the component breakdown for transparency. */
export interface ScoredComparable {
  candidate: ComparableCandidate;
  score: number;
  components: {
    genreOverlap: number;
    tierProximity: number;
    recency: number;
  };
}

/**
 * Bucket an audience count into an integer tier so "10k vs 12k" reads as the
 * same tier while "10k vs 5M" reads as far apart. Roughly one tier per order of
 * magnitude, aligned to the brief's own tier language (<100k, 100k–1M, …).
 *
 *   0: < 1k        4: 100k – 1M
 *   1: 1k – 10k    5: 1M – 10M
 *   2: 10k – 50k   6: 10M – 50M
 *   3: 50k – 100k  7: 50M+
 */
export function audienceTier(audience: number | null | undefined): number | null {
  if (audience == null || !Number.isFinite(audience) || audience < 0) return null;
  if (audience < 1_000) return 0;
  if (audience < 10_000) return 1;
  if (audience < 50_000) return 2;
  if (audience < 100_000) return 3;
  if (audience < 1_000_000) return 4;
  if (audience < 10_000_000) return 5;
  if (audience < 50_000_000) return 6;
  return 7;
}

/** Jaccard similarity of two genre-tag sets (case/whitespace-folded). */
export function genreOverlap(a: string[] | undefined, b: string[] | undefined): number {
  const setA = normalizeTags(a);
  const setB = normalizeTags(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tag of setA) {
    if (setB.has(tag)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeTags(tags: string[] | undefined): Set<string> {
  const out = new Set<string>();
  if (!tags) return out;
  for (const t of tags) {
    const norm = t.trim().toLowerCase();
    if (norm) out.add(norm);
  }
  return out;
}

/** Tier proximity in 0..1 from two audience counts. */
export function tierProximity(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const ta = audienceTier(a);
  const tb = audienceTier(b);
  if (ta == null || tb == null) return 0;
  const distance = Math.abs(ta - tb);
  return Math.max(0, 1 - distance * TIER_STEP_PENALTY);
}

/** Recency in 0..1: linear decay over `RECENCY_HORIZON_DAYS` from `asOf`. */
export function recencyScore(startDate: string | null | undefined, asOf: Date): number {
  if (!startDate) return 0;
  const started = Date.parse(startDate);
  if (Number.isNaN(started)) return 0;
  const ageDays = (asOf.getTime() - started) / 86_400_000;
  if (ageDays <= 0) return 1; // today or (defensively) future-dated
  if (ageDays >= RECENCY_HORIZON_DAYS) return 0;
  return 1 - ageDays / RECENCY_HORIZON_DAYS;
}

/** Score a single candidate against the prospect signal. */
export function scoreComparable(
  prospect: ProspectSignal,
  candidate: ComparableCandidate,
  asOf: Date,
): ScoredComparable {
  const components = {
    genreOverlap: genreOverlap(prospect.genres, candidate.genres),
    tierProximity: tierProximity(prospect.audience, candidate.audience),
    recency: recencyScore(candidate.startDate, asOf),
  };
  const score =
    GENRE_WEIGHT * components.genreOverlap +
    TIER_WEIGHT * components.tierProximity +
    RECENCY_WEIGHT * components.recency;
  return { candidate, score, components };
}

/**
 * Rank candidates most-comparable-first and return the top `limit`.
 *
 * Stable, deterministic ordering:
 *   1. higher score wins
 *   2. ties (within SCORE_EPSILON) → more recent startDate wins
 *   3. still tied → lexicographically smaller id wins
 *
 * Empty input → empty output. Pure: pass `asOf` for the recency reference.
 */
export function rankComparables(
  prospect: ProspectSignal,
  candidates: ComparableCandidate[],
  asOf: Date,
  limit = 3,
): ScoredComparable[] {
  const scored = candidates.map((c) => scoreComparable(prospect, c, asOf));
  scored.sort((x, y) => {
    if (Math.abs(x.score - y.score) > SCORE_EPSILON) return y.score - x.score;
    const dx = startDateMillis(x.candidate.startDate);
    const dy = startDateMillis(y.candidate.startDate);
    if (dx !== dy) return dy - dx; // more recent first
    return x.candidate.id < y.candidate.id ? -1 : x.candidate.id > y.candidate.id ? 1 : 0;
  });
  return limit >= 0 ? scored.slice(0, limit) : scored;
}

/** Parse a start date to millis for tie-breaking; missing/invalid sort last. */
function startDateMillis(startDate: string | null | undefined): number {
  if (!startDate) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(startDate);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

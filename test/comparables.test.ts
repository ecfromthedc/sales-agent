import { describe, it, expect } from "vitest";
import {
  audienceTier,
  genreOverlap,
  tierProximity,
  recencyScore,
  scoreComparable,
  rankComparables,
  type ComparableCandidate,
  type ProspectSignal,
  RECENCY_HORIZON_DAYS,
} from "../src/lib/comparables";

const ASOF = new Date("2026-06-05T00:00:00Z");

describe("audienceTier", () => {
  it("buckets by order of magnitude", () => {
    expect(audienceTier(500)).toBe(0);
    expect(audienceTier(5_000)).toBe(1);
    expect(audienceTier(25_000)).toBe(2);
    expect(audienceTier(75_000)).toBe(3);
    expect(audienceTier(500_000)).toBe(4);
    expect(audienceTier(5_000_000)).toBe(5);
    expect(audienceTier(25_000_000)).toBe(6);
    expect(audienceTier(80_000_000)).toBe(7);
  });

  it("returns null for missing/invalid audience", () => {
    expect(audienceTier(null)).toBeNull();
    expect(audienceTier(undefined)).toBeNull();
    expect(audienceTier(-1)).toBeNull();
    expect(audienceTier(Number.NaN)).toBeNull();
  });
});

describe("genreOverlap (Jaccard)", () => {
  it("is 1.0 for identical tag sets, case/space-insensitive", () => {
    expect(genreOverlap(["Indie Pop", "folk"], ["indie pop", " FOLK "])).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(genreOverlap(["trap"], ["folk"])).toBe(0);
  });

  it("computes partial overlap", () => {
    // {a,b} vs {b,c} → intersection 1, union 3
    expect(genreOverlap(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 10);
  });

  it("is 0 when either side has no tags", () => {
    expect(genreOverlap([], ["folk"])).toBe(0);
    expect(genreOverlap(["folk"], undefined)).toBe(0);
  });
});

describe("tierProximity", () => {
  it("is 1.0 for the same tier", () => {
    expect(tierProximity(12_000, 30_000)).toBe(1); // both tier 2
  });

  it("decays per tier of distance and floors at 0", () => {
    expect(tierProximity(5_000, 25_000)).toBeCloseTo(1 - 0.34, 10); // tier 1 vs 2
    expect(tierProximity(500, 80_000_000)).toBe(0); // tier 0 vs 7 → floored
  });

  it("is 0 when either audience is unknown", () => {
    expect(tierProximity(null, 1000)).toBe(0);
    expect(tierProximity(1000, undefined)).toBe(0);
  });
});

describe("recencyScore", () => {
  it("is 1.0 for a campaign today (or future-dated)", () => {
    expect(recencyScore("2026-06-05", ASOF)).toBe(1);
    expect(recencyScore("2027-01-01", ASOF)).toBe(1);
  });

  it("decays linearly to 0 at the horizon", () => {
    const halfway = new Date(ASOF.getTime() - (RECENCY_HORIZON_DAYS / 2) * 86_400_000);
    expect(recencyScore(halfway.toISOString(), ASOF)).toBeCloseTo(0.5, 2);
  });

  it("is 0 at/after the horizon and for missing/invalid dates", () => {
    const old = new Date(ASOF.getTime() - RECENCY_HORIZON_DAYS * 86_400_000);
    expect(recencyScore(old.toISOString(), ASOF)).toBe(0);
    expect(recencyScore(null, ASOF)).toBe(0);
    expect(recencyScore("not-a-date", ASOF)).toBe(0);
  });
});

describe("scoreComparable", () => {
  it("combines the three weighted components", () => {
    const prospect: ProspectSignal = { genres: ["folk"], audience: 12_000 };
    const candidate: ComparableCandidate = {
      id: "c1",
      artistName: "Same Lane",
      genres: ["folk"],
      audience: 30_000, // same tier (2)
      startDate: "2026-06-05", // today
    };
    const s = scoreComparable(prospect, candidate, ASOF);
    expect(s.components.genreOverlap).toBe(1);
    expect(s.components.tierProximity).toBe(1);
    expect(s.components.recency).toBe(1);
    expect(s.score).toBeCloseTo(1, 10);
  });
});

describe("rankComparables", () => {
  const prospect: ProspectSignal = { genres: ["indie pop"], audience: 40_000 }; // tier 2

  it("ranks a genre match above a non-match (genre weighted highest)", () => {
    const candidates: ComparableCandidate[] = [
      { id: "no-genre", artistName: "Trap Act", genres: ["trap"], audience: 40_000, startDate: "2026-06-01" },
      { id: "genre", artistName: "Indie Act", genres: ["indie pop"], audience: 40_000, startDate: "2026-06-01" },
    ];
    const ranked = rankComparables(prospect, candidates, ASOF, 3);
    expect(ranked[0].candidate.id).toBe("genre");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("prefers tier proximity when genre is equal", () => {
    const candidates: ComparableCandidate[] = [
      { id: "far-tier", artistName: "Stadium", genres: ["indie pop"], audience: 50_000_000, startDate: "2026-06-01" },
      { id: "near-tier", artistName: "Club", genres: ["indie pop"], audience: 45_000, startDate: "2026-06-01" },
    ];
    const ranked = rankComparables(prospect, candidates, ASOF, 3);
    expect(ranked[0].candidate.id).toBe("near-tier");
  });

  it("returns empty for empty input", () => {
    expect(rankComparables(prospect, [], ASOF, 3)).toEqual([]);
  });

  it("respects the limit", () => {
    const candidates: ComparableCandidate[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      artistName: `Act ${i}`,
      genres: ["indie pop"],
      audience: 40_000,
      startDate: "2026-06-01",
    }));
    expect(rankComparables(prospect, candidates, ASOF, 2)).toHaveLength(2);
  });

  it("breaks score ties by recency, then by id", () => {
    // Identical genre+tier → equal genre/tier components. Recency differs by date.
    const candidates: ComparableCandidate[] = [
      { id: "older", artistName: "Older", genres: ["indie pop"], audience: 40_000, startDate: "2024-01-01" },
      { id: "newer", artistName: "Newer", genres: ["indie pop"], audience: 40_000, startDate: "2026-05-01" },
    ];
    const ranked = rankComparables(prospect, candidates, ASOF, 3);
    expect(ranked[0].candidate.id).toBe("newer");
  });

  it("uses id as the final tie-break when score and date are equal", () => {
    const candidates: ComparableCandidate[] = [
      { id: "b", artistName: "B", genres: ["indie pop"], audience: 40_000, startDate: "2026-05-01" },
      { id: "a", artistName: "A", genres: ["indie pop"], audience: 40_000, startDate: "2026-05-01" },
    ];
    const ranked = rankComparables(prospect, candidates, ASOF, 3);
    expect(ranked.map((r) => r.candidate.id)).toEqual(["a", "b"]);
  });

  it("ranks CRM-style candidates (no genre/audience) by recency", () => {
    // Mirrors campaignToComparable output: only id/name/startDate present.
    const candidates: ComparableCandidate[] = [
      { id: "old", artistName: "Old Campaign", startDate: "2023-01-01" },
      { id: "recent", artistName: "Recent Campaign", startDate: "2026-04-01" },
    ];
    const ranked = rankComparables({ genres: ["pop"], audience: 100_000 }, candidates, ASOF, 3);
    expect(ranked[0].candidate.id).toBe("recent");
  });
});

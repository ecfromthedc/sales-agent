import { describe, it, expect } from "vitest";
import {
  SMOKE_STAGES,
  shapeStage,
  shapeSmokeReport,
  type StageOutcome,
  type SmokeStage,
} from "../src/lib/smoke-report";

describe("shapeStage", () => {
  it("maps a successful outcome, carrying its detail", () => {
    expect(shapeStage("pitch-composed", { ok: true, detail: "3 lines quoted" })).toEqual({
      stage: "pitch-composed",
      ok: true,
      error: null,
      detail: "3 lines quoted",
    });
  });

  it("maps a successful outcome with no detail to null detail", () => {
    expect(shapeStage("pdf-artifact", { ok: true })).toEqual({
      stage: "pdf-artifact",
      ok: true,
      error: null,
      detail: null,
    });
  });

  it("maps a failed outcome, surfacing the error", () => {
    expect(shapeStage("notion-writes", { ok: false, error: "notion_500" })).toEqual({
      stage: "notion-writes",
      ok: false,
      error: "notion_500",
      detail: null,
    });
  });

  it("falls back to unknown_error when a failure carries an empty message", () => {
    expect(shapeStage("transcript-saved", { ok: false, error: "" })).toEqual({
      stage: "transcript-saved",
      ok: false,
      error: "unknown_error",
      detail: null,
    });
  });

  it("reports an absent outcome as not_run (so the report stays exhaustive)", () => {
    expect(shapeStage("notion-writes", undefined)).toEqual({
      stage: "notion-writes",
      ok: false,
      error: "not_run",
      detail: null,
    });
  });
});

describe("shapeSmokeReport", () => {
  const meta = { service: "rt-sales-call-agent", dealId: "deal-test-123", generatedAt: "2026-06-05T00:00:00Z" };

  it("reports ok=true with all stages passing", () => {
    const outcomes: Partial<Record<SmokeStage, StageOutcome>> = {
      "deal-resolved": { ok: true, detail: "explicit deal" },
      "transcript-saved": { ok: true },
      "pitch-composed": { ok: true, detail: "3 lines" },
      "pdf-artifact": { ok: true, detail: "key" },
      "notion-writes": { ok: true },
    };
    const report = shapeSmokeReport(outcomes, meta);

    expect(report.ok).toBe(true);
    expect(report.mode).toBe("dry-run");
    expect(report.service).toBe("rt-sales-call-agent");
    expect(report.dealId).toBe("deal-test-123");
    expect(report.generatedAt).toBe("2026-06-05T00:00:00Z");
    expect(report.passed).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.stages.map((s) => s.stage)).toEqual([...SMOKE_STAGES]);
  });

  it("reports ok=false and counts failures when a stage breaks", () => {
    const outcomes: Partial<Record<SmokeStage, StageOutcome>> = {
      "deal-resolved": { ok: true },
      "transcript-saved": { ok: true },
      "pitch-composed": { ok: false, error: "pitch_must_quote_three_lines" },
      // pdf-artifact and notion-writes never ran
    };
    const report = shapeSmokeReport(outcomes, meta);

    expect(report.ok).toBe(false);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(3);

    const byStage = Object.fromEntries(report.stages.map((s) => [s.stage, s]));
    expect(byStage["pitch-composed"].error).toBe("pitch_must_quote_three_lines");
    expect(byStage["pdf-artifact"].error).toBe("not_run");
    expect(byStage["notion-writes"].error).toBe("not_run");
  });

  it("always emits every stage in canonical order, even with empty input", () => {
    const report = shapeSmokeReport({}, meta);
    expect(report.stages.map((s) => s.stage)).toEqual([...SMOKE_STAGES]);
    expect(report.stages.every((s) => s.ok === false && s.error === "not_run")).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(SMOKE_STAGES.length);
  });

  it("defaults generatedAt to an ISO timestamp when not provided", () => {
    const report = shapeSmokeReport({}, { service: "svc", dealId: "d" });
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

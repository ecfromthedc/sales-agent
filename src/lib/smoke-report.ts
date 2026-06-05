/**
 * Pure report-shaping helpers for the post-call smoke-test harness.
 *
 * The harness runs the post-call pipeline one stage at a time, catching errors
 * per stage so a single failure produces a precise report instead of a 500.
 * These helpers turn raw per-stage results into a stable, serializable report
 * with an overall pass/fail verdict.
 *
 * Kept free of `fetch`, `env`, and side effects so it can be unit-tested in
 * isolation (and so the same shaper is the single source of truth for the
 * report contract).
 */

/** Canonical, ordered list of post-call pipeline stages the harness exercises. */
export const SMOKE_STAGES = [
  "deal-resolved",
  "transcript-saved",
  "pitch-composed",
  "pdf-artifact",
  "notion-writes",
] as const;

export type SmokeStage = (typeof SMOKE_STAGES)[number];

/** Outcome of running a single stage. `ok` stages may carry a short detail. */
export type StageOutcome =
  | { ok: true; detail?: string }
  | { ok: false; error: string };

/** One stage's line in the final report. */
export interface StageReport {
  stage: SmokeStage;
  ok: boolean;
  error: string | null;
  detail: string | null;
}

/** Full smoke-test report returned to the caller. */
export interface SmokeReport {
  ok: boolean;
  mode: "dry-run";
  service: string;
  generatedAt: string;
  dealId: string;
  stages: StageReport[];
  passed: number;
  failed: number;
}

/**
 * Shape one stage's raw outcome into a report line. An absent outcome (stage
 * never reached because an earlier stage failed) is reported as a failure with
 * a clear "not_run" marker so the report is exhaustive over SMOKE_STAGES.
 */
export function shapeStage(stage: SmokeStage, outcome: StageOutcome | undefined): StageReport {
  if (!outcome) {
    return { stage, ok: false, error: "not_run", detail: null };
  }
  if (outcome.ok) {
    return { stage, ok: true, error: null, detail: outcome.detail ?? null };
  }
  return { stage, ok: false, error: outcome.error || "unknown_error", detail: null };
}

/**
 * Build the full report from a map of stage -> outcome. Always emits every
 * stage in SMOKE_STAGES order; missing stages count as failures. `ok` is true
 * only when every stage passed.
 */
export function shapeSmokeReport(
  outcomes: Partial<Record<SmokeStage, StageOutcome>>,
  meta: { service: string; dealId: string; generatedAt?: string },
): SmokeReport {
  const stages = SMOKE_STAGES.map((stage) => shapeStage(stage, outcomes[stage]));
  const passed = stages.filter((s) => s.ok).length;
  const failed = stages.length - passed;

  return {
    ok: failed === 0,
    mode: "dry-run",
    service: meta.service,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    dealId: meta.dealId,
    stages,
    passed,
    failed,
  };
}

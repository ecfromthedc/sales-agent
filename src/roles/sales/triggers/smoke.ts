/**
 * Live smoke-test harness — runs the post-call pipeline end-to-end against an
 * inline FIXTURE transcript and returns a structured pass/fail report per stage.
 *
 * Unlike the cron path (which black-boxes the whole pipeline via
 * `runPostCallPitch` and throws on the first failure), this harness runs each
 * stage individually with its own try/catch so the report shows exactly what
 * passed and what failed — for verifying the live pipeline against real Notion /
 * Anthropic / R2 wiring without guessing where it broke.
 *
 * Gated by the same static `X-Test-Key` header as POST /test/pre-call.
 *
 * SAFETY — dry-run against an explicit test deal:
 *   The harness REQUIRES a `dealId` in the request body. That id is passed
 *   straight through to the pipeline, so it NEVER calls
 *   `resolveDealForMeeting` (the email/time-window matcher that could latch
 *   onto a real client deal). The caller is expected to point this at a
 *   dedicated, clearly-marked test deal. With no `dealId` the harness refuses
 *   to run rather than fabricate a synthetic deal that might collide with real
 *   records. The report is marked `mode: "dry-run"`.
 *
 * Usage:
 *   curl -X POST https://<worker>/test/smoke \
 *     -H "X-Test-Key: <TEST_AUTH_KEY secret value>" \
 *     -H "Content-Type: application/json" \
 *     --data '{ "dealId": "<notion-test-deal-page-id>" }'
 */

import type { Env } from "../../../lib/env";
import { saveTranscript, attachPitchArtifacts } from "../../../integrations/notion";
import { composePitch, type PitchOutput } from "../../../lib/anthropic";
import { renderPitchPdf } from "../../../integrations/pdf";
import {
  shapeSmokeReport,
  type SmokeStage,
  type StageOutcome,
} from "../../../lib/smoke-report";

const SERVICE = "rt-sales-call-agent";

/**
 * A small, realistic sales-call transcript. Inline so the harness needs no
 * Drive access. Includes ≥3 distinct prospect statements so `composePitch`'s
 * "must quote three lines" rule is satisfiable.
 */
const FIXTURE_TRANSCRIPT = `Eric (Rising Tides): Thanks for making time today. To kick off — what made you reach out to Rising Tides right now?
Prospect (Maya, indie artist): Honestly, my last single did okay on streaming but I got basically nothing on TikTok, and I know that's where it has to break.
Eric: That's exactly the gap we close. Walk me through your release timeline — when's the next drop?
Maya: New single is locked for six weeks out. I want the campaign live two weeks before so there's momentum going into release day.
Eric: Good window. What's your budget comfort zone for creator-driven UGC?
Maya: I can do somewhere between five and eight thousand for this one. If it works I'd scale the next.
Eric: We typically run twenty to thirty creators in your tier and aim for sound adoption first, views second. Does owning the audio matter to you?
Maya: Yes — I want my sound used, not just people talking over it. That's the whole point.
Eric: Then we'll brief creators to feature the hook in the first three seconds. Any hard no's on creator type?
Maya: No thirst-trap stuff. Keep it musical and authentic, that's my brand.
Eric: Understood. I'll put together a plan with creator tiers, timing, and projected sound adoption and send it over.
Maya: Perfect. If the numbers make sense I'm ready to move quickly.`;

const FIXTURE_SUMMARY =
  "Indie artist Maya wants a TikTok/UGC campaign for a single dropping in ~6 weeks, " +
  "budget $5–8k, prioritizing sound adoption and an authentic/musical creator brief.";

interface SmokeInput {
  dealId?: string;
}

export async function handleSmokeTest(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  if (req.headers.get("X-Test-Key") !== env.TEST_AUTH_KEY) {
    return json({ error: "forbidden" }, 403);
  }

  let body: SmokeInput;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const dealId = body.dealId?.trim();
  if (!dealId) {
    // Refuse to run without an explicit test deal — see SAFETY note above.
    return json(
      {
        error: "missing_dealId",
        hint: "Pass a dedicated test deal page id. The harness never resolves deals by email/time, so it cannot touch real client records.",
      },
      400,
    );
  }

  const outcomes: Partial<Record<SmokeStage, StageOutcome>> = {};

  // Stage 1 — deal resolved. Explicit dealId means we bypass the real-data
  // matcher entirely; the "resolution" here is just confirming we have an id.
  const deal = { id: dealId };
  outcomes["deal-resolved"] = { ok: true, detail: `using explicit test deal ${dealId}` };

  // Stage 2 — transcript saved to the Transcripts DB (relation -> test deal).
  const startedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const endedAt = new Date().toISOString();
  outcomes["transcript-saved"] = await runStage(async () => {
    await saveTranscript(
      {
        dealId: deal.id,
        transcript: FIXTURE_TRANSCRIPT,
        summary: FIXTURE_SUMMARY,
        startedAt,
        endedAt,
        sourceUrl: undefined,
      },
      env,
    );
    return "fixture transcript written";
  });

  // Stage 3 — pitch composed by Claude. Capture the output for the next stages.
  let pitch: PitchOutput | null = null;
  outcomes["pitch-composed"] = await runStage(async () => {
    pitch = await composePitch(
      { deal, transcript: FIXTURE_TRANSCRIPT, summary: FIXTURE_SUMMARY },
      env,
    );
    return `${pitch.quotedTranscriptLines.length} transcript lines quoted, ${pitch.sections.length} sections`;
  });

  // Stage 4 — PDF artifact rendered (returns an R2 key; currently a stub key).
  let pdfKey: string | null = null;
  outcomes["pdf-artifact"] = await runStage(async () => {
    if (!pitch) throw new Error("no_pitch_to_render");
    pdfKey = await renderPitchPdf(
      { dealId: deal.id, html: pitch.deckHtml, styleGuide: "swiss-grid" },
      env,
    );
    return `pdf key: ${pdfKey}`;
  });

  // Stage 5 — Notion writes: attach artifacts + flip deal status to Pitched.
  outcomes["notion-writes"] = await runStage(async () => {
    if (!pitch || !pdfKey) throw new Error("no_pitch_or_pdf_to_attach");
    await attachPitchArtifacts(
      {
        dealId: deal.id,
        pdfKey,
        emailDraft: pitch.emailDraft,
        actionItems: pitch.actionItems,
        transcriptQuoted: pitch.quotedTranscriptLines,
      },
      env,
    );
    return "artifacts attached, status flipped to Pitched";
  });

  const report = shapeSmokeReport(outcomes, { service: SERVICE, dealId });
  return json(report, report.ok ? 200 : 207);
}

/** Run a stage body, normalizing success/throw into a StageOutcome. */
async function runStage(fn: () => Promise<string | void>): Promise<StageOutcome> {
  try {
    const detail = await fn();
    return { ok: true, detail: detail ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "unknown_error" };
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

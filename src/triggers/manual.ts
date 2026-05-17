/**
 * Manual rerun endpoint — hit from a Notion button to re-run an agent on a deal.
 * POST /runs/:dealId/:agent  where agent is "pre-call" | "post-call"
 */

import type { Env } from "../lib/env";
import { getDealById } from "../integrations/notion";
import { runPreCallBrief } from "../agents/pre-call-brief";
import { runPostCallPitch } from "../agents/post-call-pitch";

export async function handleManualRerun(
  dealId: string,
  agent: "pre-call" | "post-call",
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const deal = await getDealById(dealId, env);
  if (!deal) {
    return new Response(JSON.stringify({ error: "deal_not_found", dealId }), { status: 404 });
  }

  if (agent === "pre-call") {
    ctx.waitUntil(
      runPreCallBrief({
        inviteeEmail: deal.inviteeEmail,
        inviteeName: deal.inviteeName,
        eventStartsAt: deal.eventStartsAt,
        eventUri: deal.eventUri,
        questionsAndAnswers: deal.questionsAndAnswers,
        dealId,
      }, env),
    );
  } else {
    if (!deal.transcript) {
      return new Response(
        JSON.stringify({ error: "no_transcript", dealId, hint: "Attach transcript first" }),
        { status: 400 },
      );
    }
    ctx.waitUntil(
      runPostCallPitch({
        meetingTitle: deal.meetingTitle ?? "Rising Tides Strategy Session",
        startedAt: deal.startedAt ?? deal.eventStartsAt,
        endedAt: deal.endedAt ?? deal.eventStartsAt,
        attendees: [{ email: deal.inviteeEmail, name: deal.inviteeName }],
        transcript: deal.transcript,
        dealId,
      }, env),
    );
  }

  return new Response(JSON.stringify({ ok: true, queued: agent, dealId }), { status: 200 });
}

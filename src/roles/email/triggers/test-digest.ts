/**
 * Test endpoint — runs the read-only inbox triage digest (SALE-119) on demand
 * and reports the per-tier counts + whether a Slack post happened. Gated by the
 * same static `X-Test-Key` header as `/test/pre-call`.
 *
 * READ / NOTIFY ONLY: this exercises {@link postInboxDigest}, which runs
 * `triageInbox` (read-only Gmail) and at most a single Slack `chat.postMessage`.
 * It NEVER sends, drafts, or modifies any email. When
 * `SLACK_EMAIL_DIGEST_CHANNEL_ID` is unset the whole flow is an inert no-op
 * (`posted: false, skipped: true`, all-zero counts).
 *
 * Usage:
 *   curl -X POST https://<worker>/test/email-digest \
 *     -H "X-Test-Key: <TEST_AUTH_KEY secret value>"
 *
 * Response: { counts: { action_required, meeting_info, info_only, skip }, posted, skipped }
 */

import type { Env } from "../../../lib/env";
import { postInboxDigest } from "../digest";

export async function handleTestEmailDigest(
  req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  if (req.headers.get("X-Test-Key") !== env.TEST_AUTH_KEY) {
    return json({ error: "forbidden" }, 403);
  }

  try {
    const result = await postInboxDigest(env);
    return json({
      counts: result.counts,
      posted: result.posted,
      skipped: result.skipped ?? false,
    });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

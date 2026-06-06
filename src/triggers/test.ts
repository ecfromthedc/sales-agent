/**
 * Test endpoint — exercises the full pre-call brief pipeline against a
 * synthetic booking. Gated by a static header to keep it private.
 *
 * Usage:
 *   curl -X POST https://<worker>/test/pre-call \
 *     -H "X-Test-Key: <TEST_AUTH_KEY secret value>" \
 *     -H "Content-Type: application/json" \
 *     --data '{
 *       "email": "test@example.com",
 *       "name": "Test Artist",
 *       "spotifyLink": "https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF"
 *     }'
 */

import type { Env } from "../lib/env";
import { runPreCallBrief } from "../roles/sales/agents/pre-call-brief";

export async function handleTestPreCall(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (req.headers.get("X-Test-Key") !== env.TEST_AUTH_KEY) {
    return json({ error: "forbidden" }, 403);
  }

  let body: TestInput;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  if (!body.email || !body.name) {
    return json({ error: "missing_email_or_name" }, 400);
  }

  const startTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h from now
  const eventUri = `https://api.calendly.com/scheduled_events/test-${Date.now()}`;

  const qa: Array<{ question: string; answer: string }> = [];
  if (body.spotifyLink) {
    qa.push({
      question: "Artist's Spotify Profile Link?",
      answer: body.spotifyLink,
    });
  }
  if (body.notes) {
    qa.push({
      question: "Please share anything that will help prepare for our meeting.",
      answer: body.notes,
    });
  }

  try {
    await runPreCallBrief({
      inviteeEmail: body.email,
      inviteeName: body.name,
      eventStartsAt: startTime,
      eventUri,
      questionsAndAnswers: qa,
    }, env);

    return json({
      ok: true,
      completed: "pre-call-brief",
      fakeEvent: { eventUri, startTime },
    });
  } catch (err) {
    return json({
      ok: false,
      error: (err as Error).message,
      fakeEvent: { eventUri, startTime },
    }, 500);
  }
}

interface TestInput {
  email?: string;
  name?: string;
  spotifyLink?: string;
  notes?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

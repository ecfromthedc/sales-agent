/**
 * Public proposal viewer — serves the rendered house-style HTML from R2 at
 * GET /p/:dealId. This is the client-facing live link, so it's intentionally
 * unauthenticated. The dealId is an opaque Notion page UUID (unguessable), so
 * the link acts as a capability token.
 */

import type { Env } from "../lib/env";

export async function serveProposal(dealId: string, env: Env): Promise<Response> {
  // Guard against path tricks — dealId should be a plain id, no slashes/dots.
  if (!/^[A-Za-z0-9-]+$/.test(dealId)) {
    return new Response("not found", { status: 404 });
  }

  const obj = await env.PITCH_PDFS.get(`proposals/${dealId}/latest.html`);
  if (!obj) {
    return new Response("Proposal not found.", { status: 404 });
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

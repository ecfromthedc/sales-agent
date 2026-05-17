/**
 * HTML -> PDF rendering for the custom pitch deck.
 *
 * Path A (recommended): Use Cloudflare Browser Rendering API to print HTML to PDF,
 *                       store in R2 under `pitches/{dealId}/{timestamp}.pdf`.
 * Path B (fallback):    POST to an external renderer (e.g. self-hosted Gotenberg).
 *
 * The Swiss Grid style guide is loaded from R2 as a JSON tokens file and inlined
 * as CSS variables into the page <head> before rendering.
 */

import type { Env } from "../lib/env";

interface RenderInput {
  dealId: string;
  html: string;            // Composed by Claude
  styleGuide: "swiss-grid" | string;
}

export async function renderPitchPdf(input: RenderInput, env: Env): Promise<string> {
  // TODO: wire CF Browser Rendering binding here.
  // For now, return a placeholder key — the agent still proceeds, deal record
  // shows the PDF as pending.
  void env;
  return `pitches/${input.dealId}/pending-${Date.now()}.pdf`;
}

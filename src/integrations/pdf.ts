/**
 * HTML -> PDF rendering for the custom pitch deck.
 *
 * Renders the Claude-composed Swiss-grid HTML to a real A4 PDF using Cloudflare
 * Browser Rendering (headless Chromium via @cloudflare/puppeteer) and stores it
 * in R2 under `pitches/{dealId}/{timestamp}.pdf`. Returns the R2 object key.
 *
 * IMPORTANT — can't be verified locally:
 *   Cloudflare Browser Rendering requires the `[browser]` binding to be enabled
 *   on the account/plan and only runs inside a *deployed* Worker. `wrangler dev`
 *   and unit tests do NOT provide a live browser. This module is wired correctly
 *   for production and degrades safely everywhere else:
 *     - If `env.BROWSER` is missing (local/dev/test/binding not configured), or
 *     - If the browser/R2 round-trip throws,
 *   we log a warning and return a `pending-` placeholder key so the post-call
 *   pitch flow never breaks. The deal record then shows the PDF as pending.
 *
 * The renderPitchPdf signature is intentionally stable so callers
 * (src/agents/post-call-pitch.ts) stay untouched.
 */

import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../lib/env";
import { pitchPdfKey, pendingPitchPdfKey, finalizePitchHtml } from "../lib/pdf-key";

interface RenderInput {
  dealId: string;
  html: string;            // Composed by Claude
  styleGuide: "swiss-grid" | string;
}

export async function renderPitchPdf(input: RenderInput, env: Env): Promise<string> {
  // Graceful fallback: no browser binding (local dev / tests / binding not
  // enabled on the account). Stay honest — log and return a pending key.
  if (!env.BROWSER) {
    console.warn("pitch_pdf_browser_unavailable", {
      dealId: input.dealId,
      reason: "env.BROWSER binding not configured (local/dev or plan not enabled)",
    });
    return pendingPitchPdfKey(input.dealId);
  }

  const key = pitchPdfKey(input.dealId);
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();

    // Wait for network idle so any web fonts / inlined assets settle before printing.
    await page.setContent(finalizePitchHtml(input.html), { waitUntil: "networkidle0" });

    const pdf = await page.pdf({ format: "A4", printBackground: true });

    await env.PITCH_PDFS.put(key, pdf as unknown as ArrayBuffer | Uint8Array, {
      httpMetadata: { contentType: "application/pdf" },
    });

    return key;
  } catch (err) {
    // Never break the pitch flow on a render/storage failure — fall back to a
    // pending key and surface the failure in logs.
    console.warn("pitch_pdf_render_failed", {
      dealId: input.dealId,
      error: (err as Error).message,
    });
    return pendingPitchPdfKey(input.dealId);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeErr) {
        console.warn("pitch_pdf_browser_close_failed", (closeErr as Error).message);
      }
    }
  }
}

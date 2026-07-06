/**
 * Gemini client — ONLY does web-search-grounded research.
 *
 * Exists because the sales worker runs on DeepSeek (LLM_PROVIDER="deepseek",
 * 2026-07-06 Anthropic billing outage) and DeepSeek's Anthropic-compat layer
 * silently ignores the `web_search` server tool. Gemini's Google Search
 * grounding fills that gap: real searches, grounded text, citations.
 *
 * Workers-compatible: raw fetch, no SDK. Same shape contract as
 * `researchWithWebSearch` in lib/anthropic.ts (WebResearchResult), so the
 * enrichment layer doesn't care which provider produced the research.
 */

import type { WebResearchResult } from "./anthropic";

export interface GeminiEnv {
  GEMINI_API_KEY?: string;
}

// Pinned stable model that supports google_search grounding. Cheap + fast;
// the research output is enrichment input for the brief, not the brief itself.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
}

/**
 * Run a Google-Search-grounded research prompt. Throws on missing key or
 * non-2xx so the caller can treat it as a best-effort enrichment failure —
 * research must never block a brief.
 */
export async function researchWithGeminiSearch(
  env: GeminiEnv,
  params: { prompt: string; system: string },
): Promise<WebResearchResult> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("gemini_missing_key: GEMINI_API_KEY is unset");
  }

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: params.system }] },
      contents: [{ role: "user", parts: [{ text: params.prompt }] }],
      tools: [{ google_search: {} }],
    }),
  });
  if (!res.ok) {
    throw new Error(`gemini_${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];

  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("")
    .trim();

  // Grounding chunks carry redirect URIs + source titles (often just the
  // domain). Dedup by URI — chunks repeat per supported claim.
  const citations = new Map<string, { title: string; url: string }>();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    const url = chunk.web?.uri;
    if (url && !citations.has(url)) {
      citations.set(url, { url, title: chunk.web?.title ?? url });
    }
  }

  return { text, citations: [...citations.values()] };
}

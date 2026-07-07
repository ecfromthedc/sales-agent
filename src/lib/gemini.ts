/**
 * Gemini client — web-search-grounded research AND full composition.
 *
 * Two jobs:
 *   1. `researchWithGeminiSearch` — Google Search grounding for prospect
 *      research (real searches, grounded text, citations).
 *   2. `callGemini` — the composition adapter behind `LLM_PROVIDER="gemini"`.
 *      Translates the shared CallClaudeOptions (Anthropic Messages shape) to
 *      generateContent and maps the response back to MessagesResponse, so
 *      every compose function works unchanged.
 *
 * Workers-compatible: raw fetch, no SDK.
 */

import type { CallClaudeOptions, MessagesResponse, WebResearchResult } from "./anthropic";

export interface GeminiEnv {
  GEMINI_API_KEY?: string;
}

// Pinned stable models. Research is enrichment input, not the deliverable —
// flash. Composition mirrors the original Sonnet/Opus split: brief-tier work
// → flash, opus-tier work (pitch/proposal) → pro.
const GEMINI_RESEARCH_MODEL = "gemini-2.5-flash";
const GEMINI_COMPOSE_FLASH = "gemini-2.5-flash";
const GEMINI_COMPOSE_PRO = "gemini-2.5-pro";

const geminiUrl = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

interface GeminiResponse {
  responseId?: string;
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

/**
 * Composition adapter for LLM_PROVIDER="gemini": CallClaudeOptions in,
 * MessagesResponse out. `thinking` is dropped — Gemini 2.5 manages its own
 * reasoning budget. Throws on missing key / non-2xx, same contract as
 * callClaude.
 */
export async function callGemini(
  env: GeminiEnv,
  opts: CallClaudeOptions,
): Promise<MessagesResponse> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("llm_provider_gemini_missing_key: GEMINI_API_KEY is unset");
  }
  const model = opts.model.includes("opus") ? GEMINI_COMPOSE_PRO : GEMINI_COMPOSE_FLASH;

  const body: Record<string, unknown> = {
    contents: opts.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: opts.maxTokens },
  };
  if (opts.system !== undefined) {
    body.systemInstruction = { parts: [{ text: opts.system }] };
  }

  const res = await fetch(geminiUrl(model), {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GEMINI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`gemini_${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

  return {
    id: data.responseId ?? "gemini",
    content: [{ type: "text", text }],
    stop_reason: candidate?.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn",
    usage: {
      input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
    },
  };
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

  const res = await fetch(geminiUrl(GEMINI_RESEARCH_MODEL), {
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

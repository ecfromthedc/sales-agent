import { describe, it, expect, vi, afterEach } from "vitest";
import { callClaude, extractText, researchWithWebSearch, composeBrief } from "../src/lib/anthropic";
import type { MessagesResponse } from "../src/lib/anthropic";
import type { Env } from "../src/lib/env";

// SALE-104: callClaude is the single shared Anthropic Messages-API primitive.
// Every compose function (composeBrief, composePitch, composeProposal) routes
// the raw HTTP call through here, so these tests lock the request shape, the
// success path, and the error path in one place.

// Only ANTHROPIC_API_KEY is read by callClaude; the rest of Env is irrelevant
// to this unit, so a narrow cast keeps the fixture honest and small.
const env = { ANTHROPIC_API_KEY: "sk-test-key" } as unknown as Env;

function mockFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(async (url: unknown, init?: RequestInit) =>
    impl(String(url), init ?? {}),
  );
  // @ts-expect-error overriding the global fetch for the duration of the test
  globalThis.fetch = spy;
  return spy;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const OK_BODY = {
  id: "msg_123",
  content: [{ type: "text", text: "hello world" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 5 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("callClaude", () => {
  it("returns the parsed Messages response on success", async () => {
    mockFetch(() => jsonResponse(OK_BODY));

    const res = await callClaude(env, {
      model: "claude-sonnet-4-6",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(res.id).toBe("msg_123");
    expect(res.content[0]?.text).toBe("hello world");
    expect(res.usage.output_tokens).toBe(5);
  });

  it("POSTs to the Messages endpoint with the required headers", async () => {
    const spy = mockFetch(() => jsonResponse(OK_BODY));

    await callClaude(env, {
      model: "claude-sonnet-4-6",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("maps options onto the correct request body shape", async () => {
    const spy = mockFetch(() => jsonResponse(OK_BODY));

    await callClaude(env, {
      model: "claude-opus-4-8",
      maxTokens: 8192,
      system: "you are a test",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "claude-opus-4-8",
      max_tokens: 8192,
      system: "you are a test",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    });
    // maxTokens is mapped to max_tokens — the camelCase key must NOT leak.
    expect(body.maxTokens).toBeUndefined();
  });

  it("forwards the thinking block when provided", async () => {
    const spy = mockFetch(() => jsonResponse(OK_BODY));

    await callClaude(env, {
      model: "claude-opus-4-8",
      maxTokens: 8192,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.thinking).toEqual({ type: "adaptive" });
  });

  it("omits optional fields when not provided", async () => {
    const spy = mockFetch(() => jsonResponse(OK_BODY));

    await callClaude(env, {
      model: "claude-sonnet-4-6",
      maxTokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect("system" in body).toBe(false);
    expect("thinking" in body).toBe(false);
  });

  it("throws on a non-2xx response, tagging status and body", async () => {
    mockFetch(() => new Response("rate limited", { status: 429 }));

    await expect(
      callClaude(env, {
        model: "claude-sonnet-4-6",
        maxTokens: 1024,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/anthropic_429: rate limited/);
  });
});

// 2026-07-06: LLM_PROVIDER="gemini" routes composition through the adapter in
// lib/gemini.ts and web research through Google Search grounding (Anthropic
// account billing outage; a brief DeepSeek path was removed same-day). These
// lock the switch: URL + key selection, tier mapping (brief→flash,
// opus→pro), request/response translation, and research grounding.
describe("callClaude — LLM_PROVIDER=gemini", () => {
  const gEnv = {
    ANTHROPIC_API_KEY: "sk-ant-unused",
    GEMINI_API_KEY: "AIza-test",
    LLM_PROVIDER: "gemini",
  } as unknown as Env;

  const GEMINI_OK = {
    responseId: "resp-1",
    candidates: [
      {
        content: { parts: [{ text: "hello from gemini" }] },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
  };

  it("translates the request and maps opus-tier work to gemini-2.5-pro", async () => {
    const spy = mockFetch(() => jsonResponse(GEMINI_OK));

    const res = await callClaude(gEnv, {
      model: "claude-opus-4-8",
      maxTokens: 16000,
      system: "you are a test",
      thinking: { type: "adaptive" }, // dropped — Gemini manages its own reasoning
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "second" },
      ],
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain("gemini-2.5-pro:generateContent");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-test");
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe("you are a test");
    expect(body.generationConfig.maxOutputTokens).toBe(16000);
    // Anthropic roles map to Gemini roles; assistant → model.
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "second" }] },
    ]);
    expect("thinking" in body).toBe(false);

    // Response is mapped back to the MessagesResponse shape.
    expect(res.content[0]).toEqual({ type: "text", text: "hello from gemini" });
    expect(res.stop_reason).toBe("end_turn");
    expect(res.usage).toEqual({ input_tokens: 12, output_tokens: 7 });
  });

  it("maps brief-tier work to gemini-2.5-flash and MAX_TOKENS to max_tokens", async () => {
    const spy = mockFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }],
      }),
    );

    const res = await callClaude(gEnv, {
      model: "claude-sonnet-4-6",
      maxTokens: 8192,
      messages: [{ role: "user", content: "hi" }],
    });

    const [url] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-2.5-flash:generateContent");
    expect(res.stop_reason).toBe("max_tokens");
  });

  it("throws when LLM_PROVIDER=gemini but GEMINI_API_KEY is unset, no network", async () => {
    const spy = mockFetch(() => jsonResponse(GEMINI_OK));

    await expect(
      callClaude({ ANTHROPIC_API_KEY: "sk", LLM_PROVIDER: "gemini" } as unknown as Env, {
        model: "claude-sonnet-4-6",
        maxTokens: 100,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/llm_provider_gemini_missing_key/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an unset LLM_PROVIDER still routes to Anthropic with the Anthropic key", async () => {
    const spy = mockFetch(() => jsonResponse(OK_BODY));

    await callClaude(env, {
      model: "claude-sonnet-4-6",
      maxTokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("sk-test-key");
  });

  it("researchWithWebSearch routes to Gemini google_search grounding with deduped citations", async () => {
    const spy = mockFetch(() =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: "Grounded research about X." }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: "https://a.example/1", title: "a.example" } },
                { web: { uri: "https://a.example/1", title: "a.example" } }, // dup → dedup
                { web: { uri: "https://b.example/2", title: "b.example" } },
              ],
            },
          },
        ],
      }),
    );

    const result = await researchWithWebSearch(gEnv, {
      prompt: "who is X",
      system: "research system",
    });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("gemini-2.5-flash:generateContent");
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ google_search: {} }]);
    expect(body.systemInstruction.parts[0].text).toBe("research system");

    expect(result.text).toBe("Grounded research about X.");
    expect(result.citations).toEqual([
      { url: "https://a.example/1", title: "a.example" },
      { url: "https://b.example/2", title: "b.example" },
    ]);
  });

  it("Gemini research throws on non-2xx with a tagged error", async () => {
    mockFetch(() => new Response("quota exceeded", { status: 429 }));

    await expect(
      researchWithWebSearch(gEnv, { prompt: "x", system: "s" }),
    ).rejects.toThrow(/gemini_429: quota exceeded/);
  });

  it("composeBrief throws when the model returns no text instead of shipping an empty brief", async () => {
    // Regression: a thinking-by-default model burned the whole output cap on
    // reasoning, the run "succeeded" with briefLen 0, upserted a blank deal,
    // and Slack rejected the empty section block (invalid_blocks). Empty
    // compose = hard failure.
    mockFetch(() =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }],
      }),
    );

    await expect(
      composeBrief(
        {
          invitee: {
            inviteeEmail: "a@b.c",
            inviteeName: "A",
            eventStartsAt: "2026-07-07T00:00:00Z",
            questionsAndAnswers: [],
          },
          enrichment: {},
        },
        gEnv,
      ),
    ).rejects.toThrow(/compose_brief_empty/);
  });
});

// SALE-124: extractText is the single shared Claude text-extraction helper —
// deduped out of roles/email/reply.ts into lib/anthropic so every role uses one
// source. These lock its two behaviors: pick the first text block, and fall back
// to "" when no usable text block is present.
describe("extractText", () => {
  function resp(content: MessagesResponse["content"]): MessagesResponse {
    return {
      id: "msg_test",
      content,
      stop_reason: "end_turn",
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  it("returns the first text block's text", () => {
    expect(extractText(resp([{ type: "text", text: "hello world" }]))).toBe(
      "hello world",
    );
  });

  it("skips non-text and empty-text blocks to find the first real text", () => {
    expect(
      extractText(
        resp([
          { type: "thinking" },
          { type: "text", text: "" },
          { type: "text", text: "the answer" },
        ]),
      ),
    ).toBe("the answer");
  });

  it("falls back to the empty string when there is no text block", () => {
    expect(extractText(resp([{ type: "thinking" }]))).toBe("");
    expect(extractText(resp([]))).toBe("");
  });

  it("does NOT trim — preserves surrounding whitespace for callers", () => {
    expect(extractText(resp([{ type: "text", text: "  padded  " }]))).toBe(
      "  padded  ",
    );
  });
});

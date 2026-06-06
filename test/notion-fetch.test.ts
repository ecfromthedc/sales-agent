import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/lib/env";
import { notionFetch } from "../src/integrations/notion";

// SALE-107: the raw Notion transport was formalized into a single
// notionFetch(env, path, { method, body }) primitive that owns the base URL,
// Authorization + Notion-Version headers, and JSON request/response handling.
// All DB-specific query/CRUD helpers route through it. These tests lock its
// contract — in particular the error-string format that callers parse
// (e.g. getDealById treats `notion_404_` as "not found"). Changing that
// message would silently break those callers, so it is pinned here.

const NOTION_BASE = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// Minimal Env — only the secret the transport reads. Cast keeps the test
// focused on transport behavior without constructing the full binding set.
const env = { NOTION_API_KEY: "secret-token" } as unknown as Env;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notionFetch", () => {
  it("sets base URL, Authorization (Bearer), Notion-Version, and content-type headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await notionFetch(env, "/pages/abc");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${NOTION_BASE}/pages/abc`);
    expect(init.headers.authorization).toBe("Bearer secret-token");
    expect(init.headers["notion-version"]).toBe(NOTION_VERSION);
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("defaults to GET with no body when no options are supplied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));

    await notionFetch(env, "/pages/abc");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("uses the supplied method and JSON-stringifies the body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

    const body = { filter: { property: "Deal", relation: { contains: "x" } } };
    await notionFetch(env, "/databases/db-id/query", { method: "POST", body });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${NOTION_BASE}/databases/db-id/query`);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(body));
  });

  it("parses the JSON response body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "page-123", object: "page" }));

    const result = await notionFetch(env, "/pages/page-123");

    expect(result).toEqual({ id: "page-123", object: "page" });
  });

  it("returns null when the response has an empty body", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 200 }));

    const result = await notionFetch(env, "/pages/page-123", { method: "PATCH", body: {} });

    expect(result).toBeNull();
  });

  it("throws the `notion_${status}_${method}_${path}` error contract on non-2xx (404)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("object not found", { status: 404 }));

    // getDealById relies on `message.includes("notion_404_")` — pin the prefix.
    await expect(notionFetch(env, "/pages/missing")).rejects.toThrow(
      "notion_404_GET_/pages/missing: object not found",
    );
  });

  it("includes the method and path in the error for non-GET requests (e.g. 400 on POST)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("validation error", { status: 400 }));

    await expect(
      notionFetch(env, "/pages", { method: "POST", body: { parent: {} } }),
    ).rejects.toThrow("notion_400_POST_/pages: validation error");
  });

  it("truncates long error bodies to 400 chars", async () => {
    const longBody = "x".repeat(1000);
    fetchMock.mockResolvedValueOnce(new Response(longBody, { status: 500 }));

    await expect(notionFetch(env, "/pages/abc")).rejects.toThrow(
      `notion_500_GET_/pages/abc: ${"x".repeat(400)}`,
    );
  });
});

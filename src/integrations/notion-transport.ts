/**
 * Env-free Notion API transport.
 *
 * This module owns the low-level Notion HTTP primitive — the base URL, the
 * Notion-Version header, the Authorization header, and JSON request/response
 * handling. It is deliberately decoupled from the concrete `Env` so it can be
 * imported cross-Worker without dragging in Env's heavy bindings (e.g.
 * `@cloudflare/puppeteer`). It depends only on the minimal `NotionEnv`.
 *
 * Uses raw fetch — @notionhq/client uses Node internals that don't work in
 * Cloudflare Workers.
 *
 * The Env-coupled DB CRUD helpers live in `./notion.ts` and route through this
 * transport.
 */

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

/**
 * Minimal env surface required by the Notion transport — just the API key.
 *
 * The concrete sales `Env` is structurally assignable to this (it declares
 * `NOTION_API_KEY: string`), so existing callers passing `Env` keep working.
 */
export interface NotionEnv {
  NOTION_API_KEY: string;
}

export interface NotionFetchOptions {
  /** HTTP method. Defaults to "GET". */
  method?: string;
  /** Request body, JSON-stringified when present. */
  body?: unknown;
}

/**
 * Raw Notion API transport primitive — the single place that owns the base URL,
 * Authorization header, Notion-Version header, and JSON request/response handling.
 *
 * Every DB-specific query/CRUD helper in `./notion.ts` routes through here; there
 * are no stray inline Notion fetches.
 *
 * Error contract (relied on by callers — DO NOT change the format):
 * a non-2xx response throws `Error` with message
 *   `notion_${status}_${method}_${path}: <body excerpt>`
 * e.g. `getDealById` treats `notion_404_` as "not found" and returns null.
 */
export async function notionFetch(
  env: NotionEnv,
  path: string,
  opts: NotionFetchOptions = {},
): Promise<any> {
  const method = opts.method ?? "GET";
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.NOTION_API_KEY}`,
      "notion-version": NOTION_VERSION,
      "content-type": "application/json",
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`notion_${res.status}_${method}_${path}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

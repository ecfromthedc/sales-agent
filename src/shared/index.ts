/**
 * src/shared — cross-role primitive surface for the monorepo.
 *
 * This barrel is the single import surface for the low-level primitives that
 * every role in this codebase (sales, outreach, email, proposals) builds on:
 * the typed HTTP wrapper, the Claude/Anthropic client, and the auth/token
 * brokers for Google, Notion, and Spotify.
 *
 * It RE-EXPORTS the already-extracted primitives from their owning modules
 * (`../lib/*`, `../integrations/*`). Nothing is moved or relocated here — the
 * source files remain the single source of truth; this file only provides a
 * stable, role-agnostic entry point so call sites can write
 * `import { apiFetch } from "../shared"` instead of reaching into deep paths.
 *
 * SALE-109: capstone of the shared-core foundation (SALE-106..108).
 */

// HTTP — typed fetch wrapper + its error type (SALE-106)
export { apiFetch, HttpError } from "../lib/http";

// Anthropic — raw Claude Messages API client (Workers-compatible)
export { callClaude } from "../lib/anthropic";

// Google — OAuth access-token broker (SALE-108)
export { getGoogleAccessToken } from "../integrations/google-auth";

// Notion — authenticated Notion API fetch helper.
// SALE-133: import from the Env-free transport module so this barrel does NOT
// transitively pull in notion.ts's concrete-Env coupling (and, via Env,
// @cloudflare/puppeteer), keeping the shared surface cross-Worker importable.
export { notionFetch } from "../integrations/notion-transport";

// Spotify — client-credentials token broker
export { getSpotifyToken } from "../integrations/spotify";

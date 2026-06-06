# Architecture — RT Agents Monorepo

This repository (`ecfromthedc/sales-agent`) is the **Rising Tides Agents
monorepo**. It is no longer a single sales-agent project — it now houses
**three independent build lanes that share a common TypeScript core**. Each
lane ships on its own runtime and its own deploy path; the shared core keeps
the low-level primitives (HTTP, Claude, OAuth/token brokers) in one place so
the lanes don't re-implement them.

For sales-specific behavior and conventions, see [`CLAUDE.md`](./CLAUDE.md).

---

## 1. Overview

```
sales-agent/                    ← RT Agents monorepo
├── src/                        Lane A: SALES (CF Worker "rt-sales-call-agent")
│   ├── index.ts                  Worker entry + cron dispatch
│   ├── shared/                   Cross-role primitive barrel
│   ├── lib/                      Low-level primitives (http, anthropic, env, …)
│   ├── integrations/             Notion, Gmail, Google auth/drive, Spotify, Slack, …
│   └── roles/                    sales / email / proposals
├── outreach/                   Lane B: OUTREACH (CF Worker "rt-henry") — self-contained
├── carousels/agent/            Lane C: CAROUSELS (Rust axum local daemon)
├── test/                       Vitest suite for the sales lane (test/**)
├── .github/workflows/ci.yml    3 CI jobs (one per lane)
├── tsconfig.json               Root tsconfig — include: ["src/**/*.ts"]
├── package.json                Root scripts (typecheck, test, dev, deploy)
└── wrangler.toml               Sales worker config (name = "rt-sales-call-agent")
```

The three lanes are deliberately decoupled. The **sales** lane is the original
project and owns the repo root (`src/`, root `package.json`, root `tsconfig.json`,
root `wrangler.toml`, `test/`). The **outreach** and **carousels** lanes are
self-contained subtrees with their own build tooling.

---

## 2. The 3 Lanes

### (a) Sales — `src/`

- **Runtime:** Cloudflare Worker, name **`rt-sales-call-agent`** (from
  `wrangler.toml`, `main = "src/index.ts"`).
- **Built by:** the **root** `tsconfig.json` — `"include": ["src/**/*.ts"]` —
  and the root **Vitest** suite under `test/**`.
- **Crons** (`wrangler.toml`): `*/5 * * * *` (poll Drive for new Meet
  transcripts every 5 min) and `7 13 * * *` (daily inbox-triage email digest,
  inert until `SLACK_EMAIL_DIGEST_CHANNEL_ID` is set — read/notify only).
- **What it does:** Calendly-booked sales calls → pre-call brief + post-call
  pitch deck in Notion. Plus the email role and the proposals pipeline (see §4).

### (b) Outreach (Henry) — `./outreach/`

- **Runtime:** Cloudflare Worker, name **`rt-henry`** (from
  `outreach/wrangler.toml`, `main = "src/index.ts"`).
- **Self-contained:** has its own `package.json`, `tsconfig.json`, and
  `wrangler.toml`. It was **subtree'd into the monorepo with its full history**
  (it began life as the separate `outreach-agent` repo) and still builds and
  deploys entirely from within `./outreach/`.
- **Crons** (`outreach/wrangler.toml`): `0 8 * * *` (daily release scan),
  `0 9 * * 1` (weekly Monday gap analysis), `0 */2 * * *` (inbox cleaner every
  2 hours).
- **What it does:** proactive outbound lead generation — label watcher, gap
  finder, outreach drafter, lead scorer, inbox cleaner. Code under
  `outreach/src/` (`agents/`, `lib/`, `integrations/`).

### (c) Carousels — `./carousels/agent/`

- **Runtime:** Rust **axum** HTTP service — a **local daemon**, not a Worker.
  Crate **`rt-carousel-agent`** (from `carousels/agent/Cargo.toml`, edition
  2024, binary `rt-carousel-agent` at `src/main.rs`).
- **Runtime-local:** drives **headless Chrome** (`headless_chrome` crate) to
  screenshot rendered HTML into 1080×1350 PNGs, so it runs on a real machine
  rather than in the edge sandbox. Stack: axum + tokio + reqwest + askama +
  `headless_chrome`.
- **What it does:** Rising Tides Instagram carousel generation (Midnight Press
  voice) — HTML render → PNG/PDF → posted back to Slack.

---

## 3. Shared Core — `src/shared`

`src/shared/index.ts` is a **barrel** — the single, role-agnostic import surface
for the low-level primitives every sales-lane role builds on. It **re-exports**
the already-extracted primitives from their owning modules (nothing is moved or
relocated; `../lib/*` and `../integrations/*` remain the source of truth):

| Re-exported symbol | Source module | Purpose |
|--------------------|---------------|---------|
| `apiFetch`, `HttpError` | `../lib/http` | Typed `fetch` wrapper + its error type |
| `callClaude` | `../lib/anthropic` | Raw Claude Messages API client (Workers-compatible) |
| `getGoogleAccessToken` | `../integrations/google-auth` | Google OAuth access-token broker |
| `notionFetch` | `../integrations/notion` | Authenticated Notion API fetch helper |
| `getSpotifyToken` | `../integrations/spotify` | Spotify client-credentials token broker |

Call sites import `{ apiFetch }` from `"../shared"` instead of reaching into deep
paths.

---

## 4. `src/roles/`

### sales — `src/roles/sales/`

The original product. Three subdirectories:

- **`agents/`** — `pre-call-brief.ts`, `post-call-pitch.ts`, `proposal-drafter.ts`.
- **`triggers/`** — Worker routes / entry points: `calendly-poll.ts`,
  `calendly-webhook.ts`, `fireflies-webhook.ts`, `transcript-poll.ts`,
  `transcript-webhook.ts`, `proposal-public.ts`, `slack-events.ts`,
  `slack-interactions.ts`, `manual.ts`, `smoke.ts`, `test.ts`.
- **`integrations/`** — `calendly.ts`, `crm-lookup.ts`, `pdf.ts`,
  `proposal-render.ts`, `tides-tracker.ts`.

### email — `src/roles/email/`

The email role consolidates the chief-of-staff triage spec and the loose
`email-*.py` Gmail scripts into one home. Files:

| File | Concern |
|------|---------|
| `triage.ts` | **Pure, deterministic** 4-tier classifier (`classifyEmail`): `skip` / `info_only` / `meeting_info` / `action_required`. No I/O, no network. |
| `inbox.ts` | **Strictly read-only** Gmail inbox digest — only `messages.list` + `messages.get`; never drafts/send/modify/trash/labels. |
| `digest.ts` | **Notify-only** — runs the read-only triage and posts a summary to Slack (no-op if channel/token unset). |
| `reply.ts` | Composes an outbound reply **DRAFT only** behind a human gate — only `drafts.create`, **never** any send/dispatch endpoint. |
| `unsubscribe.ts` | **Pure extraction only** — parses `List-Unsubscribe` headers into options; never fetches, POSTs, or actions an unsubscribe. |

`triggers/test-digest.ts` is the role's only trigger so far (test entry).

**NEVER-auto-send doctrine.** The email role is **read / notify / draft-only**.
It reads inboxes, surfaces digests to Slack, and stages reply drafts — but it
**never sends, never auto-unsubscribes, never mutates the inbox**. A human (Eric)
reviews and presses send. This mirrors the rest of the monorepo's
"draft-only, human-in-the-loop" constraint and is a permanent design boundary,
not a phase.

### proposals — `src/roles/proposals/`

A **thin README pointer**, not a separate pipeline. There is no standalone
proposals pipeline — the canonical proposals surface IS the **sales** proposal
pipeline (`src/roles/sales/agents/proposal-drafter.ts`,
`integrations/proposal-render.ts`, `triggers/proposal-public.ts` +
`fireflies-webhook.ts` + Slack refine triggers). The README points there and
explicitly says: extend the sales role, do not fork the pipeline here.

---

## 5. CI Gates — `.github/workflows/ci.yml`

Three jobs run on every PR and push to `main` — one gate per lane:

| Job (`name:`) | Lane | What it runs |
|---------------|------|--------------|
| `typecheck + tests` | sales | `npm install` → `npm run typecheck` → `npm test` (root) |
| `outreach typecheck` | outreach | `npm install` → `npm run typecheck` in `outreach/` |
| `carousels cargo check` | carousels | `cargo check` in `carousels/agent` (Rust toolchain + cache) |

---

## 6. Build / Test / Deploy per Lane

### Sales (root)

```bash
npm install
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run deploy       # wrangler deploy  → rt-sales-call-agent
npm run tail         # wrangler tail
```

### Outreach (`./outreach/`)

```bash
cd outreach
npm install
npm run typecheck    # tsc --noEmit
npm run dev          # wrangler dev
npm run deploy       # wrangler deploy  → rt-henry
```

### Carousels (`./carousels/agent/`)

```bash
cd carousels/agent
cargo check          # CI gate
cargo build --release
cargo run            # runs the rt-carousel-agent axum daemon locally
```

---

## 7. Known Remaining Work — Integration Dedup

The outreach lane still carries **its own copies** of integrations that overlap
the shared core: `outreach/src/integrations/{gmail.ts, notion.ts, spotify.ts}`
duplicate concerns already extracted into `src/shared` (`notionFetch`,
`getSpotifyToken`) and `src/integrations` (`gmail.ts`, `spotify.ts`, `notion.ts`).

Deduping these honestly requires an **npm-workspace restructure** so the
`outreach` lane can import the shared core as a workspace package rather than
shipping forked copies. That restructure is **deliberately not done yet** — the
outreach subtree currently stays self-contained (own `package.json` /
`tsconfig.json` / `wrangler.toml`) so it builds and deploys independently. Until
the workspace migration lands, the duplication is a known, accepted seam.

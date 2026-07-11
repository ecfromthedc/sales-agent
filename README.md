# RT Sales Call Agent

Closes the lag between "great Calendly call" and "send the pitch" — under 15 minutes, end-to-end.

**Full spec:** `~/Documents/Obsidian Vault/Rising Tides OS/Reference/Sales-Call-Agent-Spec.md`

## What it does

1. **Pre-call brief** — Calendly booking comes in → agent enriches via Spotify + Gmail + Notion CRM + Tides Tracker + web → one-page brief lands in Notion before the meeting
2. **Post-call pitch** — Meet transcript lands → agent builds a Swiss-grid custom pitch deck (HTML→PDF) + drafts a follow-up email quoting the call → attached to the Notion deal record within 15 min

## Stack

- Cloudflare Workers + Durable Objects (runtime)
- Notion API (primary store)
- Calendly webhooks (booking trigger)
- Granola or Drive watch (transcript trigger)
- Spotify Web API, Gmail API, Tides Tracker internal API (enrichment)
- Claude (Sonnet 4.6 for briefs, Opus 4.5 with extended thinking for pitch composition)

## Architecture

```
Calendly booking ──▶ CF Worker ──▶ pre-call brief ──▶ Notion deal record
                                           │
                                           ▼
                              Eric joins Google Meet
                                           │
                                           ▼
                  Granola/Drive transcript ──▶ CF Worker
                                           │
                                           ▼
                     pitch deck (PDF) + email draft ──▶ Notion
```

## Layout

```
src/
  index.ts                  Worker entry, router
  triggers/
    calendly-webhook.ts     POST /webhooks/calendly (booking.created)
    transcript-webhook.ts   POST /webhooks/transcript (granola or drive)
    manual.ts               POST /runs/:dealId/:agent (rerun button)
  agents/
    pre-call-brief.ts       Runs the pre-call enrichment + brief composition
    post-call-pitch.ts      Runs the post-call deck + email composition
  integrations/
    calendly.ts             Booking payload parser, event-type lookup
    notion.ts               Deal / Transcript / Pitch Artifact CRUD
    spotify.ts              Client Credentials flow + artist enrichment
    gmail.ts                OAuth search across past convos
    tides-tracker.ts        Past RT campaign lookup
    granola.ts              Transcript ingest
    pdf.ts                  HTML→PDF via Swiss Grid style guide
  lib/
    anthropic.ts            Claude client wrapper
    notion-schema.ts        Generated TS types for Notion tables
    secrets.ts              CF env binding helpers
wrangler.toml
package.json
.env.example
```

## Dev

```bash
cd ~/Projects/active/rt-sales-call-agent
npm install
npx wrangler dev          # local dev
npx wrangler deploy       # to Cloudflare
```

## Security notes

- **Proposal links are unguessable capability URLs (no expiry).** The public
  client-facing viewer serves the rendered proposal at `GET /p/:dealId`
  (`src/roles/sales/triggers/proposal-public.ts`). It is intentionally
  unauthenticated: the `dealId` is an opaque Notion page UUID, so knowing the
  full URL is what grants access — the link itself acts as a capability token.
  The id is path-guarded (`isValidDealId` in `src/lib/proposal-security.ts`) so a
  crafted value can never escape the `proposals/<id>/latest.html` R2 key prefix,
  and responses send `Cache-Control: no-store` + `X-Robots-Tag: noindex,
  nofollow`. There is **no TTL or revocation** today, so a link that leaks (e.g.
  forwarded email, shared screenshot) stays live indefinitely. Recommended
  follow-up: add a signed-token TTL and/or a per-deal revocation flag so links
  can be expired or killed. Tracked as a low-priority hardening item — treat any
  proposal link as sensitive until then.

- **`wrangler.toml` holds infra identifiers, not secrets.** The committed
  `[vars]` block (Cloudflare `account_id`, the `STATE` KV namespace id, the R2
  bucket name, and the `NOTION_*_DB_ID` values) are non-secret resource
  identifiers, safe to keep in version control. They name resources but do not
  grant access on their own. All actual secrets — `NOTION_API_KEY`,
  `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, the Calendly / Spotify / Gmail
  credentials, `FIREFLIES_WEBHOOK_SECRET`, etc. — are injected via
  `wrangler secret put` and are never committed (see the "Required secrets"
  comment in `wrangler.toml` and `.dev.vars.example`).

## Status

Scaffold in place (2026-05-14). Notion schema + Calendly webhook are the next two builds.

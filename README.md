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

## Status

Scaffold in place (2026-05-14). Notion schema + Calendly webhook are the next two builds.

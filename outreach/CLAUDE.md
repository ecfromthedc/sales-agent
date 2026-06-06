# Henry — RT Outreach Agent

**Repo path:** `/Users/ericcromartie/Documents/Development/outreach-agent`  
**Cloudflare Worker name:** `rt-henry`  
**Email:** `henry@risingtidesent.com`  
**Owner:** Rising Tides agency — Eric Cromartie (`ec@risingtidesent.com`)

---

## What this project does

Proactive outbound lead generation — finds labels/artists RT should pitch, watches their release cadences, and drafts contextual outreach emails. Target: always-ready pipeline of warm leads timed to release windows.

| Flow | Trigger | Output |
|------|---------|--------|
| **Label watcher** | Cron (daily) | Detect new releases from tracked labels, flag outreach windows |
| **Gap finder** | Cron (weekly) or manual | Compare CRM clients vs. label rosters → identify unworked artists/labels |
| **Outreach drafter** | New opportunity flagged | Contextual email draft → Notion + Gmail draft |
| **Lead scorer** | On enrichment | Score leads by fit (genre, tier, release timing, past relationship) |
| **Inbox cleaner** | Cron (every 2h) | Archive junk from henry@ (Cloudflare-routed notifications) |

**Not in scope:** Inbound deal flow (that's `rt-sales-call-agent`), live chat, cold-call scripts, automated sending (human approves all outreach).

---

## Stack

- **Runtime:** Cloudflare Workers (`src/index.ts`), cron daily + weekly
- **Store:** Notion (Leads DB, Labels DB, Artists DB, Outreach Log DB)
- **Data Sources:** Spotify (releases, artist roster), Gmail (relationship history), Notion CRM (existing clients)
- **AI:** Anthropic Messages API via raw `fetch` (Workers-compatible)
  - Lead scoring / gap analysis: **Sonnet** (`claude-sonnet-4-5-20250929`)
  - Outreach email drafts: **Sonnet** (fast, good tone)
- **Artifacts:** KV `OUTREACH_STATE` for poll cursors and watcher state

---

## Layout

```
src/
  index.ts                       Routes + scheduled cron
  triggers/
    manual.ts                      POST /runs/:action (rerun any agent)
    test.ts                        POST /test/scan
  agents/
    label-watcher.ts               Monitor label release cadences via Spotify
    gap-finder.ts                  CRM vs. market gap analysis
    outreach-drafter.ts            Compose contextual outreach emails
    lead-scorer.ts                 Score and prioritize opportunities
    inbox-cleaner.ts               Archive junk from henry@ (Cloudflare-routed noise)
  watchers/
    release-cadence.ts             Track weekly/monthly release patterns per label
    social-monitor.ts              Watch social channels for timing signals (future)
  integrations/
    notion.ts                      Leads, Labels, Artists, Outreach Log DBs
    spotify.ts                     Artist search, label roster, new releases
    gmail.ts                       Relationship history lookup, draft creation
    google-auth.ts                 OAuth token management
  lib/
    env.ts                         Env bindings + secrets list
    anthropic.ts                   composeDraft / scoreLeads / analyzeGaps
    types.ts                       Shared types (Label, Artist, Lead, Opportunity)
scripts/
  deploy.sh                        Full deploy script
  create_notion_schema.py          Notion DB setup
  seed-labels.ts                   Initial label import from CRM
wrangler.toml                      Worker config, cron, KV
.dev.vars.example                  Secret template
```

---

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | `{ ok: true, service: "rt-henry", agent: "Henry" }` |
| `POST` | `/runs/scan-releases` | Trigger release scan now |
| `POST` | `/runs/find-gaps` | Trigger gap analysis now |
| `POST` | `/runs/clean-inbox` | Sweep junk from Henry's inbox now |
| `POST` | `/runs/draft/:leadId` | Draft outreach for specific lead |
| `POST` | `/runs/score` | Re-score all pending leads |
| `GET` | `/status` | Current watcher state, last run times |

---

## Dev commands

```bash
cd /Users/ericcromartie/Documents/Development/outreach-agent
npm install
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm run deploy       # wrangler deploy
./scripts/deploy.sh  # full deploy
```

---

## Secrets & config

**Local:** `.dev.vars` (see `.dev.vars.example`)  
**Production:** `wrangler secret put <NAME>`

Required: `ANTHROPIC_API_KEY`, `NOTION_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `GMAIL_OAUTH_CLIENT_ID`, `GMAIL_OAUTH_CLIENT_SECRET`, `GMAIL_OAUTH_REFRESH_TOKEN` (for henry@risingtidesent.com)  
Optional: `RT_SLACK_NOTIFY_WEBHOOK`

**Vars in `wrangler.toml`:** Notion DB IDs (LEADS_DB_ID, LABELS_DB_ID, ARTISTS_DB_ID, OUTREACH_LOG_DB_ID)

---

## Core concepts

### Label Watcher
- Pulls label rosters from Spotify (by label name search or known artist→label mapping)
- Tracks release cadence: how often a label drops, which tier artists get releases when
- Flags "outreach windows" — 2-4 weeks before typical release cycles when labels are planning promo

### Gap Finder
- Reads all labels/artists from Notion CRM (past + current clients)
- Cross-references against known label rosters
- Identifies: labels we've worked with but have unworked artists, sister labels, similar-tier labels we haven't touched
- Scores gaps by proximity to existing relationships

### Outreach Drafter
- Takes an opportunity (label + artist + timing signal)
- Enriches with: Gmail history (past convos with label contacts), Spotify metrics, CRM notes
- Drafts personalized outreach email referencing shared history, timing, and specific value prop
- Saves draft to Notion Outreach Log + optionally creates Gmail draft

### Lead Scorer
- Genre fit (do we have case studies in this genre?)
- Tier fit (is this artist's follower count in our sweet spot?)
- Timing (is a release coming? are they planning promo?)
- Relationship proximity (have we worked with their label before? same A&R?)
- Recency (how fresh is this opportunity?)

---

## Working in this repo (for Claude Code)

1. **Read before changing:** `src/agents/*` for business logic; `src/integrations/notion.ts` for lead lifecycle.
2. **Workers constraints:** No Node-only APIs; prefer `fetch` over SDKs.
3. **Never auto-send:** All outreach is draft-only. Human (Eric) reviews and sends.
4. **Idempotent enrichment:** Use `Promise.allSettled` — partial Spotify/Gmail failures don't block scoring.
5. **Do not invent** metrics, case studies, or campaign results — only use real data from CRM + Spotify.
6. **Tone:** Confident but not pushy. Reference real shared history. No generic templates.
7. **Typecheck** after TS changes: `npm run typecheck`.

---

## Relationship to sales-agent

| | Sales Agent | Outreach Agent |
|-|-------------|----------------|
| **Direction** | Inbound (they book a call) | Outbound (we find them) |
| **Trigger** | Calendly booking | Release cadence / gap analysis |
| **Output** | Pre-call brief + post-call pitch | Outreach email draft + lead score |
| **CRM** | Deals DB | Leads DB + Labels DB |
| **Shared** | Spotify, Gmail, Notion, Anthropic | Same |

# RT Sales Call Agent

**Repo path:** `/Users/ericcromartie/Documents/Development/sales-agent`  
**Cloudflare Worker name:** `rt-sales-call-agent` (package + deploy name; folder is `sales-agent`)  
**Owner:** Rising Tides agency — Eric Cromartie (`ec@risingtidesent.com`)

**Product spec (source of truth for behavior):**  
`~/Documents/Obsidian Vault/Rising Tides OS/Reference/Sales-Call-Agent-Spec.md`

---

## What this project does

Closes the lag between a Calendly strategy call and sending the pitch — target **under 15 minutes** end-to-end.

| Flow | Trigger | Output |
|------|---------|--------|
| **Pre-call brief** | Calendly `invitee.created` (webhook or 5‑min poll) | One-page brief in Notion before the meeting |
| **Post-call pitch** | Google Drive transcript (5‑min poll) or manual rerun | Swiss-grid HTML→PDF deck (R2), follow-up email draft, action items → Notion |
| **Proposal draft** | Manual `POST /runs/:dealId/proposal` after transcript exists | Client-facing proposal HTML/PDF placeholder, follow-up email, assumptions/missing data/source claims → Notion |

**Not in scope:** live browser chat, Salesforce/HubSpot, or a local `crm/` / `knowledge-base/` folder. CRM is **Notion**; enrichment is **Spotify + Gmail + Tides Tracker**.

---

## Stack

- **Runtime:** Cloudflare Workers (`src/index.ts`), cron every 5 min
- **Store:** Notion (Deals, Transcripts, Pitch Artifacts DBs)
- **Triggers:** Calendly webhooks/poll, Drive transcript poll, manual `POST /runs/:dealId/:agent`
- **AI:** Anthropic Messages API via raw `fetch` in `src/lib/anthropic.ts` (not the Node SDK)
  - Pre-call brief: **Sonnet** (`claude-sonnet-4-5-20250929`)
  - Post-call pitch: **Opus + extended thinking** (`claude-opus-4-5-20250929`)
- **PDF:** `src/integrations/pdf.ts` (Swiss Grid style)
- **Artifacts:** R2 bucket `rt-sales-pitch-pdfs`, KV `STATE` for poll cursors

---

## Layout

```
src/
  index.ts                     Routes + scheduled cron
  triggers/
    calendly-webhook.ts          POST /webhooks/calendly
    calendly-poll.ts             Cron fallback for bookings
    transcript-poll.ts           Cron: new files in Meet recordings folder
    transcript-webhook.ts        POST /webhooks/transcript (future)
    manual.ts                    POST /runs/:dealId/pre-call|post-call
    test.ts                      POST /test/pre-call
  agents/
    pre-call-brief.ts            Enrich → compose brief → Notion
    post-call-pitch.ts           Transcript → deck + email → Notion + R2
    proposal-drafter.ts          Deal + transcript → proposal artifact → Notion + R2 seam
  integrations/
    calendly.ts, notion.ts, spotify.ts, gmail.ts,
    google-drive.ts, google-auth.ts, tides-tracker.ts, pdf.ts
  lib/
    env.ts                       Env bindings + secrets list
    anthropic.ts                 composeBrief / composePitch
scripts/                         deploy, secrets, Notion schema, rotation
wrangler.toml                    Worker name, vars, R2, KV, cron
.dev.vars                        Local secrets (gitignored) — copy from .dev.vars.example
```

---

## HTTP API

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | `{ ok: true, service: "rt-sales-call-agent" }` |
| `POST` | `/webhooks/calendly` | New booking → pre-call brief |
| `POST` | `/webhooks/transcript` | Transcript push (optional) |
| `POST` | `/test/pre-call` | Dev smoke test |
| `POST` | `/runs/:dealId/pre-call` | Rerun pre-call agent |
| `POST` | `/runs/:dealId/post-call` | Rerun post-call agent |
| `POST` | `/runs/:dealId/proposal` | Draft client-facing proposal artifact from deal transcript |

Calendly event type: `https://calendly.com/ec-risingtidesent/rising-tides-strategy-session`

---

## Dev commands

```bash
cd /Users/ericcromartie/Documents/Development/sales-agent
npm install
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm run deploy       # wrangler deploy
./scripts/deploy.sh  # full deploy: KV/R2, secrets, typecheck, deploy
```

Override repo path for scripts: `export RT_AGENT_REPO=/Users/ericcromartie/Documents/Development/sales-agent`

---

## Secrets & config

**Local:** `.dev.vars` (see `.dev.vars.example`)  
**Production:** `wrangler secret put <NAME>`  
**1Password:** "RT Sales Call Agent - Secrets" in vault "Rising Tides Production"

Required: `ANTHROPIC_API_KEY`, `NOTION_API_KEY`, `CALENDLY_PERSONAL_ACCESS_TOKEN`, `CALENDLY_WEBHOOK_SIGNING_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `GMAIL_OAUTH_*` (Gmail + Drive scopes), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`  
Optional: `TIDES_TRACKER_API_KEY`, `RT_SLACK_NOTIFY_WEBHOOK`

**Vars in `wrangler.toml`:** Notion DB IDs, `MEET_RECORDINGS_FOLDER_ID`, optional Slack webhook.

**Setup / rotation prompts (browser agents):**

- `SETUP_BROWSER_PROMPT.md` — initial credential capture
- `FINISH_SETUP_BROWSER_PROMPT.md` — post-deploy unblockers
- `ROTATION_BROWSER_PROMPT.md` — secret rotation after leak

Never commit `.dev.vars`, `.env`, or paste secrets into chat logs.

---

## Working in this repo (for Claude Code)

1. **Read before changing:** `src/agents/*` for business logic; `src/integrations/notion.ts` for deal lifecycle; `src/lib/anthropic.ts` for prompts/models.
2. **Workers constraints:** No Node-only APIs in the hot path; prefer `fetch` over `@anthropic-ai/sdk` in Workers code.
3. **Idempotent enrichment:** Pre-call uses `Promise.allSettled` — partial failures must not block the brief.
4. **Deal matching:** Post-call resolves deals by attendee email (non-`@risingtidesent.com`) or meeting time window.
5. **Do not invent** pricing, case studies, or campaign results — only use enrichment + transcript + Notion fields.
6. **Tone:** Rising Tides voice in system prompts (`PRE_CALL_BRIEF_SYSTEM`, `POST_CALL_PITCH_SYSTEM` in `anthropic.ts`).
7. **Typecheck** after TS changes: `npm run typecheck`.
8. **Duplicate folder:** `~/Documents/Development/rt-sales-call-agent` may exist as a copy; treat **this** `sales-agent` path as canonical unless Eric says otherwise.

---

## Pre-call brief flow (implementation)

1. Parse Calendly payload → invitee email/name, Q&A (Spotify link question).
2. Parallel enrich: Spotify (if link), Gmail history, Tides Tracker past campaigns.
3. `composeBrief()` → markdown brief.
4. `upsertDeal()` in Notion, status `Briefed`.

---

## Post-call pitch flow (implementation)

1. Poll Drive folder `MEET_RECORDINGS_FOLDER_ID` for new transcript files.
2. `resolveDealForMeeting()` → save transcript row.
3. `composePitch()` → deck HTML, email draft (≥3 quoted moments), action items.
4. `renderPitchPdf()` → R2; `attachPitchArtifacts()` → Notion; status `Pitched`.

---

## Related docs in repo

| File | Use |
|------|-----|
| `README.md` | Overview + architecture diagram |
| `SETUP_BROWSER_PROMPT.md` | First-time API keys |
| `FINISH_SETUP_BROWSER_PROMPT.md` | Gmail/Drive/Calendly finish |
| `ROTATION_BROWSER_PROMPT.md` | Rotate leaked secrets |

---

## Example tasks Claude should handle well

- Wire or fix Calendly webhook signature verification
- Improve transcript filename parsing in `google-drive.ts`
- Tune pre-call/post-call/proposal system prompts without breaking JSON output contracts
- Add Notion property mappings when schema changes (`scripts/create_notion_schema.py`)
- Debug cron poll cursors in KV (`transcript-poll.ts`, `calendly-poll.ts`)
- Harden deploy script or wrangler bindings after infra changes

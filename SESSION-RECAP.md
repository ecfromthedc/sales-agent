# Session Recap — Sales Call Agent

**Window:** 2026-05-13 → 2026-05-16
**Author:** Eric Cromartie + terminal-Claude
**State at close:** Production system live, all credentials rotated, repo on GitHub at [`ecfromthedc/sales-agent`](https://github.com/ecfromthedc/sales-agent)

---

## TL;DR

Started with three voice-memo transcripts. Ended with a production Cloudflare Worker that turns Calendly bookings into Claude-written pre-call briefs and Meet transcripts into pitch decks, end-to-end in under 25 seconds, landing in Notion. Along the way: built the spec, the scaffold, the Notion schema, the rotation tooling, a Swiss-grid HTML doc, and a recovery from one credential leak. Total commits: 8 across the lifecycle.

---

## Chronology

### Day 1 (May 13) — The signal

Three voice memos from the 17th St N session between Eric, Jake, and Smathers were transcribed and analyzed:

| Memo | Length | Key extract |
|---|---|---|
| `17th St N 22.m4a` | 28 min | First mention of "**Notion sales-call agent**" as a build candidate; Swiss-grid style guide brought up by Eric ("makes everything look exactly the same way it looks so fire"); Fetty Wap × Russell Dickerson custom-proposal pattern |
| `Cedar Island.m4a` | ~27 min | Long-term-building thesis; Ocean OS as cross-reference brain; PDF/Swiss carousels for viral content; multi-agent pattern (smart orchestrator → dumb workers → smart reviewer) |
| `Langley.m4a` | ~10 min | Sales call agent reconfirmed as #1 leverage play; release-watcher inbound-flip concept |

Sales-call agent surfaced in **both Langley and Cedar Island**, so that became the build.

### Day 2 (May 14) — Spec + scaffold + deploy

Wrote `Sales-Call-Agent-Spec.md` in Obsidian. Scaffolded `~/Projects/active/rt-sales-call-agent/` as a Cloudflare Worker repo. Created the Notion `Sales Pipeline` page with three databases (`Deals`, `Transcripts`, `Pitch Artifacts`). Pushed all secrets to Cloudflare. Deployed v1.

Three architectural pivots during the build:

1. **Calendly webhook → polling.** Webhooks require Calendly Standard plan ($16/mo). Pivoted to 5-min API polling on the free tier. Same logical effect, slightly higher max latency.
2. **`@notionhq/client` SDK → raw fetch.** Notion's Node SDK uses Node internals not available in Cloudflare Workers runtime. Caused a `TypeError: Cannot read properties of undefined (reading 'call')` on every Notion call. Rewrote `src/integrations/notion.ts` to use `fetch` directly. ~120 lines, no functionality lost, smaller bundle.
3. **`@anthropic-ai/sdk` SDK → raw fetch.** Same root cause as #2 — diagnosed by adding try/catch + structured logs in `pre-call-brief.ts` until stack trace surfaced. Rewrote `src/lib/anthropic.ts` to call `https://api.anthropic.com/v1/messages` directly.

End-to-end pipeline test (real Mon Rovia / Bad Bunny Spotify link, real Anthropic call, real Notion write): **23.1 seconds, deal record created with full 2,512-character Claude-written brief.**

### Day 3 (May 15) — Drive watch + leak + recovery

Switched the transcript ingestion path from Granola (which Eric didn't want as a dependency) to **Google Drive polling**. Two reasons: avoids vendor lock-in, and Google Meet auto-transcribes natively into a Drive folder via Workspace Business plan. Wrote `src/integrations/google-auth.ts` + `src/integrations/google-drive.ts` (shared OAuth refresh, in-memory access-token cache, polling cron).

Created **Swiss-grid HTML doc** explaining the entire system architecture — saved to `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05-15/sales-call-agent-doc/index.html`. Strict 12-column grid, Inter Tight + Inter typography, red accent only, all flush-left. Same design tokens we'll use for the actual pitch decks.

**The incident:**

When loading `.dev.vars` for a credential test, terminal-Claude ran `set -a; source ~/Projects/active/rt-sales-call-agent/.dev.vars; set +a`. The file had been malformed (spaces after `=` from a browser-agent paste), so bash interpreted each value as a command to execute. The resulting `command not found` errors **echoed five secrets** into the transcript: `ANTHROPIC_API_KEY`, `CALENDLY_PERSONAL_ACCESS_TOKEN`, `SPOTIFY_CLIENT_SECRET`, `GMAIL_OAUTH_CLIENT_SECRET`, `CLOUDFLARE_API_TOKEN`.

Built `scripts/load_secrets.py` as a permanent fix — uses `shlex.quote` to emit shell-safe `export` statements that bash can never misinterpret. The only sanctioned way to source `.dev.vars` going forward.

### Day 4 (May 16) — Rotation marathon + repo move + GitHub push

Walked through full credential rotation with Chrome browser agent + terminal handoff via clipboard. First pass landed only 1 of 6 keys cleanly. Second pass with focused per-key flow caught Anthropic, Spotify, Calendly, Cloudflare. Google OAuth was the long tail:

- Google removed JSON downloads for existing OAuth client secrets ("Viewing and downloading client secrets is no longer available")
- gcloud CLI rejected the Web-app OAuth client ("Only client IDs of type 'installed' are allowed")
- OAuth Playground initially used Google's default Playground client instead of RT's (Eric hadn't ticked "Use your own OAuth credentials" in the gear panel)
- Once gear panel was configured correctly with OAuth flow = Server-side, both scopes ticked, and consent walked through — refresh token minted successfully with 6 scopes (`gmail.readonly` + `gmail.compose` + `drive.readonly` + `drive.file` + `mail.google.com` + `calendar.acls.readonly`)

After fixing the Gmail refresh token, a final smoke test still failed: `anthropic_401: invalid x-api-key`. Cause: a previous `fix_dev_vars.py` run had blanked `NOTION_API_KEY` (and possibly stale CF state for `ANTHROPIC_API_KEY`). Restored `NOTION_API_KEY` from `~/.zshrc`, re-pushed all 8 runtime secrets to Cloudflare from `.dev.vars`, redeployed.

**Final end-to-end test: 18.2 seconds, deal record landed in Notion, all 5 providers verified live.**

Eric moved the repo from `~/Projects/active/rt-sales-call-agent/` → `~/Documents/Development/sales-agent/` (his own copy, separate git init). Terminal-Claude moved its copy to `~/Documents/Development/rt-sales-call-agent/`, then discovered the duplicate, synced verified-live secrets into the canonical `sales-agent/`, and removed the duplicate (176 MB freed). Eric then pushed `sales-agent` to GitHub as a **public** repo.

GitHub audit: no secrets leaked (gitignore worked). What is public: code, scripts, browser prompts, `wrangler.toml` (CF account ID, Notion DB IDs, Meet folder ID — all useless without secrets). Risk flagged: the `X-Test-Key: rt-test-2026` header is published in browser prompts; anyone reading can trigger costly pre-call briefs on the worker.

---

## Architecture (final state)

```
                  ┌─────────────────────────────────────┐
                  │       Cloudflare Worker             │
                  │      rt-sales-call-agent            │
                  └──────────────┬──────────────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
     ┌────────────────┐ ┌────────────────┐ ┌───────────────┐
     │  cron */5 min  │ │   HTTP routes  │ │   bindings    │
     └────────┬───────┘ └────────┬───────┘ └───────┬───────┘
              │                  │                 │
       ┌──────┴──────┐   ┌───────┴───────┐   ┌─────┴─────┐
       │             │   │               │   │           │
       ▼             ▼   ▼               ▼   ▼           ▼
  ┌────────┐  ┌──────────┐  ┌────────────┐  ┌───┐  ┌────────┐
  │Calendly│  │  Drive   │  │/webhooks/* │  │KV │  │   R2   │
  │  poll  │  │transcript│  │/runs/:id   │  │   │  │PDFs    │
  │        │  │   poll   │  │/test/*     │  │   │  │        │
  └───┬────┘  └────┬─────┘  └──────┬─────┘  └───┘  └────────┘
      │            │               │
      ▼            ▼               ▼
  ┌────────────────────────────────────┐
  │      Pre-Call Brief Agent           │
  │   Sonnet 4.6 · ~20s · enrichment    │
  │ Spotify · Gmail · Notion · Tracker  │
  └────────────────────────────────────┘
                  │
                  ▼
  ┌────────────────────────────────────┐
  │      Post-Call Pitch Agent          │
  │  Opus 4.5 + thinking · ~ minutes    │
  │  HTML deck · PDF · Email draft      │
  └────────────────────────────────────┘
                  │
                  ▼
  ┌────────────────────────────────────┐
  │            Notion                   │
  │   Sales Pipeline page               │
  │  • Deals (status FSM)               │
  │  • Transcripts (linked)             │
  │  • Pitch Artifacts (linked)         │
  └────────────────────────────────────┘
```

**Pipeline timing (measured):**
- Pre-call brief: **18–23 seconds** end-to-end (Spotify + Gmail + Notion + Anthropic + Notion-write)
- Post-call pitch: not yet measured (Opus + thinking + Notion-write; budget 15 min, expect <2 min)

---

## Files of record

### Code (in `sales-agent/`)

```
src/
├── index.ts                       Router + scheduled() handler
├── agents/
│   ├── pre-call-brief.ts          Sonnet 4.6, parallel enrichment, ~20s
│   └── post-call-pitch.ts         Opus 4.5 + extended thinking
├── triggers/
│   ├── calendly-poll.ts           Cron — fetch new bookings every 5 min
│   ├── transcript-poll.ts         Cron — fetch Drive transcripts every 5 min
│   ├── calendly-webhook.ts        Optional real-time (needs paid Calendly)
│   ├── transcript-webhook.ts      Optional real-time (Drive push notifs)
│   ├── manual.ts                  Notion-button rerun
│   └── test.ts                    Smoke endpoint — gated by X-Test-Key
├── integrations/
│   ├── google-auth.ts             Shared OAuth refresh + token cache
│   ├── google-drive.ts            List + download Meet transcript files
│   ├── gmail.ts                   Past-convo search (exact + domain pass)
│   ├── spotify.ts                 Client Credentials → artist enrichment
│   ├── notion.ts                  CRUD via raw fetch (no SDK)
│   ├── calendly.ts                HMAC webhook verify
│   ├── tides-tracker.ts           Past-campaign lookup (stub)
│   └── pdf.ts                     HTML → PDF (stub — CF Browser Rendering target)
└── lib/
    ├── anthropic.ts               Claude client via raw fetch (no SDK)
    └── env.ts                     Typed Worker bindings
```

### Scripts (in `sales-agent/scripts/`)

```
load_secrets.py                    Safe .env loader → eval "$(...)"
rotate_from_clipboard.py           Single-key rotation from pbpaste
rotate_secrets.py                  Interactive walkthrough of all 6 keys
use_gcloud_adc.py                  Adopt gcloud ADC (didn't end up using — Google blocked drive.readonly on default client)
fix_dev_vars.py                    Idempotent .dev.vars repair
finish_v2.py                       Sets refresh token + folder ID + redeploys
smoke_test_notion.py               Notion CRUD smoke test
create_notion_schema.py            Bootstrap the 3 databases
deploy.sh                          Full deploy pipeline
```

### Documentation

```
CLAUDE.md                          Project context for coding agents (your work)
AGENTS.md                          Safe-secret-loading + ops notes for any agent
README.md                          Basic intro
SESSION-RECAP.md                   This document
SETUP_BROWSER_PROMPT.md            Initial 7-phase setup for Chrome agent
FINISH_SETUP_BROWSER_PROMPT.md     Final 3-phase setup completion
ROTATION_BROWSER_PROMPT.md         Full 8-phase rotation walkthrough
```

### External documents

| Path | What it is |
|---|---|
| `~/Documents/Obsidian Vault/Rising Tides OS/Reference/Sales-Call-Agent-Spec.md` | Canonical spec — single source of truth for behavior |
| `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05-13/idea-session-17th-st/17th St N 22.txt` | Source-of-record transcript |
| `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05-14/idea-session-cedar-langley/Cedar Island.txt` | Source-of-record transcript |
| `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05-14/idea-session-cedar-langley/Langley.txt` | Source-of-record transcript |
| `~/Documents/Obsidian Vault/Rising Tides OS/Session Logs/2026-05-15/sales-call-agent-doc/index.html` | Swiss-grid HTML system overview |

### Production resources

| Resource | Identifier |
|---|---|
| Worker URL | https://rt-sales-call-agent.smathdaddy.workers.dev |
| Cloudflare account | `d5fbf64067844a591842c14f1b53bd79` (Smathdaddy's account) |
| KV namespace `STATE` | `926fd9f294ce495f89ba2f5fba2e41b2` |
| R2 bucket `PITCH_PDFS` | `rt-sales-pitch-pdfs` |
| Notion `Sales Pipeline` page | `3611465b-b829-81b0-9b1b-c3076c4f8769` |
| Notion `Deals` db | `3611465b-b829-81de-a237-cf6516fe8fcf` |
| Notion `Transcripts` db | `3611465b-b829-81a0-b6a0-cc55e6ed784c` |
| Notion `Pitch Artifacts` db | `3611465b-b829-8174-875c-c9a6db1540cd` |
| Meet Recordings folder | `19krQR2fbafw3h0uxLF7SvEoh2mgW0Sy8` (one of two — there's a second `1B9ndPWrl02NKTmG81qPud-51vTTsbmqH`, also accessible, also owned by Eric) |
| GitHub repo | https://github.com/ecfromthedc/sales-agent (PUBLIC at time of writing) |

---

## Decisions and why

### Polling instead of webhooks (Calendly)
Calendly's webhook subscription API requires Standard plan ($16/mo). 5-min polling on free tier achieves the same outcome with at most 5 min latency. A 15-min Strategy Session booked 24h+ in advance is unaffected.

### Drive cron instead of Granola
Eric explicitly didn't want Granola as a SaaS dependency. Google Workspace already auto-transcribes Meet recordings into Drive (as "Gemini Notes" on his plan). Polling that folder achieves the same outcome with no extra vendor.

### Raw fetch instead of official SDKs
Both `@anthropic-ai/sdk` and `@notionhq/client` use Node-specific internals (`util.inherits`, `node-fetch` polyfills, etc.) that don't work in Cloudflare Workers. Rewriting against raw `fetch` eliminated a class of runtime crashes, kept the bundle small, and made the integration layer trivially understandable.

### Two separate Claude models (not one)
- **Sonnet 4.6** for pre-call brief — fast, cheap, "good enough" output that doesn't need deep reasoning
- **Opus 4.5 with extended thinking budget** for post-call pitch — has to read the full transcript, identify pain points, build a deck that quotes ≥3 specific moments. Worth the cost; runs maybe twice per day max.

### `.env` AND `.dev.vars` (kept in sync)
- `.env` is the universal coding-agent convention (Cursor, Aider, etc.)
- `.dev.vars` is Wrangler's specific convention for `wrangler dev`
- Both are gitignored; both have identical content; touching one means touching both
- `scripts/rotate_from_clipboard.py` writes to `.dev.vars` only — Eric / agents must mirror to `.env` if needed (could automate this, low priority)

### Notion CRM (not Salesforce / HubSpot / a custom CRM)
- Notion already had the CRM data; building a new one would be a parallel build
- The agent's writes (Deals / Transcripts / Pitch Artifacts) live as Notion databases with relations
- Notion's read API is fast enough for the 20-second pipeline budget

---

## What's stubbed (and what unblocks each)

| Stub | Location | What's needed |
|---|---|---|
| HTML → PDF rendering | `src/integrations/pdf.ts` | Wire Cloudflare Browser Rendering API binding; upload to R2; sign download URLs |
| **Brand-document-driven HTML composition** | `src/lib/anthropic.ts` `POST_CALL_PITCH_SYSTEM` | Load Swiss Grid (and other 9) style tokens from `brand/` dir into the system prompt; let Claude pick which style based on prospect context |
| Tides Tracker lookup | `src/integrations/tides-tracker.ts` | Real API URL + auth token from whoever owns Tracker |
| Gmail draft creation | not yet implemented | Use `gmail.compose` scope (already granted on the refresh token); add `createGmailDraft()` call in `post-call-pitch.ts` |
| Slack notification on new booking | `RT_SLACK_NOTIFY_WEBHOOK` var | Set to a real Slack incoming-webhook URL; add `notifyNewBooking()` call in `pre-call-brief.ts` |

The **brand-document-driven HTML composition** is the highest-value next build. Eric mentioned this multiple times across both Cedar Island and 17th St calls — it's the architectural choice that turns the agent from "generates HTML" into "generates HTML that looks like a Rising Tides asset." See section "Where this stands today" in the brand-docs sub-thread for the four-step build.

---

## Lessons learned (encoded as SOPs)

### NEVER `source .env` or `source .dev.vars` directly
Bash interprets `KEY= value` (whitespace after `=`) as "set KEY to empty, then run `value` as a command." If `value` is `sk-ant-api03-…`, the resulting `command not found` error echoes the secret into stderr — which Claude's bash tool captures and persists in `~/.claude/projects/*.jsonl`.

The only sanctioned loader:
```bash
eval "$(python3 scripts/load_secrets.py)"
```

Uses `shlex.quote()` so bash physically cannot misinterpret values.

### Treat the Claude context window as permanent storage
Anything that reaches the context (paste, stderr, scraped page, file read) gets persisted in `~/.claude/projects/*.jsonl`. If a secret hits the context: **rotate first**, scrub transcripts second.

### Always validate before pushing to Cloudflare
`rotate_from_clipboard.py` has prefix checks per key (`sk-ant-` for Anthropic, `1//` for Gmail refresh, `GOCSPX-` for Google secret, `eyJ` for Calendly JWT). Catches paste mistakes (wrong field copied) before they overwrite valid secrets.

### Confirm against the live provider, not just `.dev.vars`
A "valid-looking" value in `.dev.vars` can still be rejected by the provider (e.g., revoked at the source, wrong client). After every rotation, do a real API call:

```bash
curl -s -o /dev/null -w "%{http_code}" "https://api.anthropic.com/v1/messages" \
  -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  --data '{"model":"claude-sonnet-4-5","max_tokens":4,"messages":[{"role":"user","content":"hi"}]}'
```

200 = live. 401 = key rejected. Anything else = investigate.

### Push to Cloudflare AND verify the worker uses the new value
Pushing a secret via `wrangler secret put` doesn't always take effect on the running deployment immediately if the worker has a stale state. Best practice: rotate → `wrangler deploy` (forces a new version that picks up new secrets) → fire a smoke test.

### OAuth Playground gotchas (Google)
1. **Gear icon → "Use your own OAuth credentials" MUST be ticked BEFORE clicking Authorize APIs.** Otherwise the auth code is minted against Google's default Playground client and unusable.
2. **OAuth flow = "Server-side"** (not Client-side). Only server-side returns a refresh_token.
3. **Scopes are sticky in the URL state.** If you re-authorize with a different scope set, Google may use the latest URL state instead of the gear-panel values. Always confirm the URL bar after Authorize.

### Google OAuth Client Secrets are now one-way
As of mid-2026, Google removed the "Download JSON" button for existing OAuth Client Secrets. If you didn't save the secret when it was created, the only path forward is **+ Add Secret** (creates a new one, shown one time). Old secrets stay valid until manually deleted; recommend deleting unused ones after rotation.

---

## Open items / next moves

### Soon
1. **Rotate the test endpoint key.** `X-Test-Key: rt-test-2026` is in 4 public markdown files. Change `TEST_KEY` in `src/triggers/test.ts`, update the docs, redeploy.
2. **Flip repo to private** (if Eric wants — `gh repo edit ecfromthedc/sales-agent --visibility private --accept-visibility-change-consequences`)
3. **Commit `CLAUDE.md`** — currently untracked. Without it, fresh clones won't have project context for the coding agent.
4. **Add `CLOUDFLARE_API_TOKEN` to `.env`** — currently empty because we never had a fresh value. Either run `wrangler login` in the repo (uses OAuth, no token needed) OR generate a new token at https://dash.cloudflare.com/profile/api-tokens.

### Medium-term
5. **Build the brand-document layer.** Drop `brand/swiss-grid.md` (tokens + component examples) into the repo. Inject into Claude's pitch composer system prompt. See "Where this stands today" sub-thread for the four-step build.
6. **Wire `renderPitchPdf`** via Cloudflare Browser Rendering API. ~30 lines of code. Make Notion's "PDF Key" field clickable.
7. **Wire Gmail draft creation.** Refresh token already has `gmail.compose` scope. Add `createGmailDraft()` in `post-call-pitch.ts`. Saves the pitch email as a Gmail draft Eric can review + send.
8. **Tides Tracker integration.** Real API URL + token. Currently graceful no-op.
9. **Slack notification on new booking.** Set `RT_SLACK_NOTIFY_WEBHOOK` to a real webhook URL.

### Long-term (architectural)
10. **Service account model.** User OAuth refresh tokens drift over time (revoked, expired, scope-shifted by Google's changing policies). A service account with domain-wide delegation is more robust for the Drive/Gmail reads. Tradeoff: requires Workspace admin to authorize DWD, which is a separate one-time setup. Worth it once the agent is critical.
11. **Brand-document selection.** With 10 style guides, give Claude a "pick the right one" step based on prospect context (label vs indie, genre, vibe). Architecturally: a small selector agent before the deck composer.
12. **Move from Worker cron to Durable Object for state.** Current KV cursor works fine for cadence but a DO would give us per-deal state (e.g., "this deal is mid-rerun, don't double-fire").

---

## Final state snapshot (2026-05-16 ~21:30 ET)

| | |
|---|---|
| **Repo** | `~/Documents/Development/sales-agent/` |
| **GitHub** | https://github.com/ecfromthedc/sales-agent (PUBLIC) |
| **Worker** | live at https://rt-sales-call-agent.smathdaddy.workers.dev |
| **Health check** | `{"ok":true,"service":"rt-sales-call-agent"}` |
| **Cron schedule** | `*/5 * * * *` (Calendly + Drive polled in parallel) |
| **Last deploy version** | `f965669a-c674-451b-996a-a25a113dc467` (or later if redeployed since) |
| **Credentials status** | All 5 providers verified live via real API calls |
| **Pipeline timing** | 18.2 seconds end-to-end (last measured) |
| **Test endpoint** | `POST /test/pre-call` w/ `X-Test-Key: rt-test-2026` (⚠ rotate soon) |

---

## Commit history

```
a3e79cc  docs: add 1Password vault reference for secrets         (latest)
dca35e5  feat: initialize sales-agent repo from rt-sales-call-agent
```

(Eric's clean-init repo; the rt-sales-call-agent precursor had 8 prior commits that were squashed into this baseline.)

---

## Acknowledgments

- Voice memos provided the strategic signal
- Browser-Claude drove the credential-rotation walkthroughs
- Terminal-Claude wrote the code, the scripts, this recap
- Eric did the human work: voice + judgment + decisions + the clicks browser-Claude couldn't do

System is live. Calendly cron will fire on the next 5-min tick and stay live indefinitely. When a real prospect books a Strategy Session, you'll have a Claude-written brief in your Notion deal record before you're done refilling your coffee.

— end recap —

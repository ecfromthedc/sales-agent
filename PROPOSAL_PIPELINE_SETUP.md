# Proposal Pipeline — Setup Checklist

Wires the post-call proposal flow:

```
Fireflies (call recorded) ─▶ /webhooks/fireflies ─▶ fetch transcript ─▶ resolve deal
  ─▶ Claude drafts proposal ─▶ render house-style HTML ─▶ host on R2 (/p/:dealId)
  ─▶ post live link to Slack #proposals (C0B670L4VRS)
  ─▶ Eric replies in thread to refine ─▶ regenerate + repost updated link
```

The code is built and typechecks. The steps below are the **dashboard/secret work** that only you can do. Nothing here auto-sends client email (Gmail compose is intentionally out of scope for now).

---

## 1. Confirm the public Worker URL  ⚠️ verify before deploy

Proposal live links are built from `PUBLIC_BASE_URL` in `wrangler.toml`. I set a guess:

```
PUBLIC_BASE_URL = "https://rt-sales-call-agent.risingtidesent.workers.dev"
```

Confirm your actual `workers.dev` subdomain (Cloudflare dashboard → Workers → your worker → the URL), or set a custom domain, and update that var. If it's wrong, the "Open proposal" links in Slack point nowhere.

## 2. Slack app — Events API + scopes (the refine loop)

In api.slack.com/apps → your RT bot app:

1. **OAuth & Permissions → Bot Token Scopes** — ensure these exist, then **reinstall** the app if you add any:
   - `chat:write` (post proposals + replies)
   - `channels:history` (read thread replies in the public #proposals channel) — use `groups:history` instead if C0B670L4VRS is private
2. **Event Subscriptions → Enable Events**
   - Request URL: `https://<your-worker>/slack/events` — Slack will send a challenge; the Worker answers it automatically (deploy first).
   - **Subscribe to bot events:** `message.channels` (or `message.groups` for a private channel).
   - Save.
3. **Basic Information → App Credentials → Signing Secret** → copy it:
   ```bash
   wrangler secret put SLACK_SIGNING_SECRET   # paste the Slack signing secret
   ```
4. **Invite the bot to the channel:** in C0B670L4VRS, `/invite @<botname>`.

Without the signing secret the events endpoint returns 401 to everything (fail-closed) — so refine won't work until step 3 is done.

## 3. Fireflies webhook

1. Secrets:
   ```bash
   wrangler secret put FIREFLIES_API_KEY          # Fireflies API key
   wrangler secret put FIREFLIES_WEBHOOK_SECRET   # the HMAC secret you set in Fireflies
   ```
2. In Fireflies → Settings → Developer/Webhooks: set the webhook URL to
   `https://<your-worker>/webhooks/fireflies`, event **"Transcription completed"**, and use the same secret as above.

> Deal matching: the proposal resolves the deal by a Fireflies **attendee email** that isn't `@risingtidesent.com`, falling back to the meeting start-time window. Make sure the prospect is an actual attendee on the calendar invite so the booking matches.

## 4. Chartmetric (already wired)

```bash
wrangler secret put CHARTMETRIC_REFRESH_TOKEN   # the new token AFTER you rotate the leaked one
```
Safeguards already in code: KV-cached access token (1 auth / 55 min), 24h per-artist result cache, 429-bail, and a hard **200 calls/UTC-day circuit breaker** (`DAILY_CALL_CEILING` in `src/integrations/chartmetric.ts`). Bump that constant if call volume ever grows.

## 5. Deploy

```bash
cd /Users/ericcromartie/Documents/Development/sales-agent
./scripts/deploy.sh     # pushes secrets from .dev.vars, typechecks, deploys
```

Add `SLACK_SIGNING_SECRET=` and `CHARTMETRIC_REFRESH_TOKEN=` to your local `.dev.vars` so `deploy.sh` can push them (CHARTMETRIC is already there).

## 6. Smoke test the full loop

1. Record a real (or test) call in Fireflies with a prospect attendee email that matches a Notion deal.
2. On "Transcription completed", check Slack #proposals for the proposal post with an **Open proposal** button.
3. Open the link → confirm the house-style proposal renders (`/p/:dealId`).
4. Reply in the thread: e.g. *"make tier 2 $8k"* → within ~20-30s a threaded reply should appear with the updated link.
5. Confirm the Notion Pitch Artifact has the **Live proposal:** link + PRD.

---

## What's in scope vs. not

| In scope (built) | Not yet |
|---|---|
| Fireflies → auto proposal draft | Gmail "ready-to-send" draft (deferred per your call) |
| House-style HTML live link on R2 | PDF download variant |
| Slack post + thread refine loop | Auto-send to client |
| Notion PRD + live link attach | "Proposal URL" Notion property (link is in the page body; add a URL property later via `scripts/create_notion_schema.py` if you want it filterable) |

## Files touched
- `src/integrations/proposal-render.ts` *(new)* — PRD → house-style HTML
- `src/triggers/proposal-public.ts` *(new)* — serves `GET /p/:dealId` from R2
- `src/triggers/slack-events.ts` *(new)* — signed Events API + thread refine
- `src/agents/proposal-drafter.ts` — render/host/Slack-live-link + `runProposalFromMeeting` + `refineProposal`
- `src/triggers/fireflies-webhook.ts` — now routes to the proposal drafter
- `src/lib/anthropic.ts` — `composeProposal` refinement mode
- `src/integrations/notion.ts` — `attachProposalArtifact` accepts `proposalUrl`
- `src/index.ts`, `src/lib/env.ts`, `wrangler.toml`, `scripts/deploy.sh`, `.dev.vars.example`

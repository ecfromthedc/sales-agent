# Browser Agent Setup Prompt — RT Sales Call Agent

Copy everything below the `===START===` line into Claude in Chrome.

The agent will walk through 6 phases, capture every credential it finds, and report each one back in chat for Eric to copy. It will NOT save credentials to disk or send them anywhere external.

---

===START===

You are setting up external credentials for a Cloudflare Worker called `rt-sales-call-agent`. I (Eric) am at the keyboard. Your job is to drive the browser through 6 web-based setup phases, capture the credential each phase produces, and report them back to me as a clean checklist at the end.

**Hard rules:**
- After each phase, print: `✅ Phase N done. Captured: <KEY_NAME>=<value>` so I can paste it into my terminal.
- Never paste credentials into any external site, never email them, never save to disk. Just show them to me in chat.
- If a phase requires me to do something physical (download an app, click a confirmation in another window, approve in 1Password), pause and tell me exactly what to do, then wait for me to type `done`.
- If a page looks different than the steps describe (UIs change), describe what you see and ask me which button to click.
- Go in order. Do not skip phases.

---

## Phase 1 — Cloudflare API Token (5 min)

We need a token so `wrangler deploy` works from the command line.

1. Open https://dash.cloudflare.com/profile/api-tokens
2. If I'm not logged in, ask me to log in and type `done` when ready.
3. Click **Create Token**.
4. Find the **Edit Cloudflare Workers** template, click **Use template**.
5. Account Resources: leave as "All accounts" (or pick the only one).
6. Zone Resources: leave as "All zones from an account."
7. Scroll down, click **Continue to summary**, then **Create Token**.
8. Copy the long token shown on the success page.
9. Report: `✅ Phase 1 done. Captured: CLOUDFLARE_API_TOKEN=<token>`
10. Also note my Cloudflare Account ID (visible in the right sidebar of any dashboard page). Report: `CLOUDFLARE_ACCOUNT_ID=<id>`

---

## Phase 2 — Spotify Web API app (5 min)

We need Client ID + Secret so the agent can pull artist data from Spotify links submitted via Calendly.

1. Open https://developer.spotify.com/dashboard
2. Log in with my Spotify account if prompted, then `done`.
3. Click **Create app** (top right).
4. Fill in:
   - App name: `RT Sales Call Agent`
   - App description: `Internal sales enrichment for Rising Tides agency`
   - Website: `https://risingtidesent.com`
   - Redirect URI: `https://rt-sales-call-agent.workers.dev/oauth/spotify/callback` (we won't actually use it for Client Credentials flow but it's required)
   - APIs: check **Web API**
   - Agree to ToS, click **Save**.
5. On the app page, click **Settings**.
6. Copy **Client ID**.
7. Click **View client secret**, copy that too.
8. Report:
   ```
   ✅ Phase 2 done. Captured:
   SPOTIFY_CLIENT_ID=<value>
   SPOTIFY_CLIENT_SECRET=<value>
   ```

---

## Phase 3 — Google Cloud OAuth for Gmail (10 min)

We need the agent to read Eric's Gmail to surface past convos with prospects. Three sub-tasks: project, OAuth consent screen, OAuth client.

### 3a. Create or pick a Google Cloud project

1. Open https://console.cloud.google.com
2. If I'm not signed in as ec@risingtidesent.com, ask me to switch accounts, then `done`.
3. Top bar, click the project picker.
4. If there's already a project named `rising-tides` or similar, select it and skip to 3b.
5. Otherwise click **New Project**, name it `rising-tides-sales-agent`, click **Create**, wait for it to provision, then select it.

### 3b. Enable Gmail API

1. Open https://console.cloud.google.com/apis/library/gmail.googleapis.com
2. Click **Enable**. Wait until it shows "API enabled."

### 3c. Configure OAuth consent screen

1. Open https://console.cloud.google.com/apis/credentials/consent
2. Pick **External**, click **Create**.
3. App info:
   - App name: `RT Sales Call Agent`
   - User support email: `ec@risingtidesent.com`
   - Developer contact: `ec@risingtidesent.com`
4. Click **Save and Continue**.
5. Scopes screen: click **Add or Remove Scopes**. Tick:
   - `https://www.googleapis.com/auth/gmail.readonly`
   Click **Update**, then **Save and Continue**.
6. Test users: click **Add Users**, add `ec@risingtidesent.com`, click **Add**, then **Save and Continue**.
7. Summary screen: click **Back to Dashboard**.

### 3d. Create OAuth client

1. Open https://console.cloud.google.com/apis/credentials
2. Click **+ Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Name: `RT Sales Call Agent`.
5. Authorized redirect URIs: add `https://developers.google.com/oauthplayground`
6. Click **Create**.
7. A popup shows Client ID and Client Secret. Copy both.
8. Report:
   ```
   ✅ Phase 3 done. Captured:
   GMAIL_OAUTH_CLIENT_ID=<value>
   GMAIL_OAUTH_CLIENT_SECRET=<value>
   ```

---

## Phase 4 — Mint a Gmail refresh token via OAuth Playground (5 min)

A refresh token lets the worker call Gmail forever without re-prompting.

1. Open https://developers.google.com/oauthplayground/
2. Click the gear icon (top right) → tick **Use your own OAuth credentials**.
3. Paste the `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` from Phase 3 into the two fields shown. Click **Close**.
4. In the left panel under **Step 1**, scroll to find **Gmail API v1**. Expand it. Tick `https://www.googleapis.com/auth/gmail.readonly`.
5. Click **Authorize APIs** (blue button bottom of step 1).
6. Google login screen — sign in as ec@risingtidesent.com, then `done`.
7. You'll see a warning "Google hasn't verified this app." Click **Advanced → Go to RT Sales Call Agent (unsafe)** → **Continue**.
8. Back in OAuth Playground, **Step 2** appears. Click **Exchange authorization code for tokens**.
9. Copy the **Refresh token** from the response panel.
10. Report:
    ```
    ✅ Phase 4 done. Captured:
    GMAIL_OAUTH_REFRESH_TOKEN=<value>
    ```

---

## Phase 5 — Anthropic API key (2 min)

Worker uses this for the Claude model calls in the brief and pitch agents.

1. Open https://console.anthropic.com/settings/keys
2. If I'm not logged in, ask me to log in (Eric uses ec@risingtidesent.com), then `done`.
3. Click **Create Key**.
4. Name: `rt-sales-call-agent`. Workspace: pick the RT workspace (or Default if none). Permissions: Default.
5. Click **Add**.
6. Copy the `sk-ant-...` key shown ONCE on the success screen.
7. Report:
   ```
   ✅ Phase 5 done. Captured:
   ANTHROPIC_API_KEY=<value>
   ```

---

## Phase 6 — Granola webhook signing key (5 min — depends on Granola version)

Granola is the meeting capture tool. If I don't have it installed yet, pause and tell me to download from https://www.granola.ai/download, install, and sign in with ec@risingtidesent.com — wait for me to type `done`.

Once Granola is installed:

1. Open Granola desktop app (it's an app, not a website, so direct me through it via screenshots if you can't drive it).
2. Settings → Integrations → Webhooks (path may differ; if so, describe what you see and ask).
3. Add a webhook:
   - URL: `https://rt-sales-call-agent.<my-account-subdomain>.workers.dev/webhooks/transcript`  ← we'll fix the real URL after Phase 1, so for now use `https://example.com/placeholder` and I'll update it post-deploy.
   - Events: `transcript.ready` (or whatever the closest equivalent is — "meeting ended with transcript" works).
4. Save. Granola will display a signing secret.
5. Report:
   ```
   ✅ Phase 6 done. Captured:
   GRANOLA_WEBHOOK_SIGNING_KEY=<value>
   ```

If Granola's UI doesn't expose a webhook config (older versions don't), report: `⚠️ Phase 6 blocked: Granola version on this Mac doesn't support webhooks. Fallback: use Drive watch on Meet Recordings folder. Suggest Eric upgrade Granola or pick fallback.`

---

## Phase 7 — Calendly Webhook Signing Key (3 min)

The worker verifies Calendly webhook signatures. The signing key comes from creating the webhook subscription via Calendly API — we can do this with curl, so just collect the Personal Access Token here.

1. Open https://calendly.com/integrations/api_webhooks
2. Under **Personal Access Tokens**, click **Generate New Token**.
3. Name: `rt-sales-call-agent`. Click **Create**.
4. Copy the token shown once.
5. Report:
   ```
   ✅ Phase 7 done. Captured:
   CALENDLY_PERSONAL_ACCESS_TOKEN=<value>
   ```
   (Eric will use this to subscribe the webhook via curl after the worker deploys — the webhook signing key Calendly returns will be added then.)

---

## Final summary

After all phases done, print one consolidated block in this exact format so Eric can paste straight into a `.dev.vars` file:

```
# Paste into ~/Projects/active/rt-sales-call-agent/.dev.vars

CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
ANTHROPIC_API_KEY=...
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
GMAIL_OAUTH_REFRESH_TOKEN=...
GRANOLA_WEBHOOK_SIGNING_KEY=...
CALENDLY_PERSONAL_ACCESS_TOKEN=...
```

Then tell Eric: `All 7 phases complete. Paste the block above into .dev.vars and tell your Claude Code agent "secrets ready" to continue the build.`

===END===

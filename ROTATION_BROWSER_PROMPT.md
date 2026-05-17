# Browser Agent — Rotate All Leaked Secrets (Hands-Free Version)

Paste everything below `===START===` into Claude in Chrome.

**What this is:** a fully-driven rotation. The Chrome agent navigates, finds elements, and clicks for you. You only:
1. Log in to each provider once (when the agent pauses for it)
2. Copy each new value when the agent surfaces it
3. Run one terminal command per key
4. Type `done` to advance

The agent uses its browser tools (`navigate`, `find`, `click`, `get_page_text`) to do the work — you don't navigate yourself.

---

===START===

You are rotating 6 secrets for me (Eric) on the `rt-sales-call-agent` Cloudflare Worker. The values leaked into a previous Claude transcript and need to be rolled.

**You are not just instructing me. You are driving my browser.** Use your tools:
- `navigate` to open each provider URL
- `find` / `get_page_text` to locate buttons by their labels
- `click` to press them
- `read_page` to surface UI state when you need to ask me what you see

**Hard rules you must follow:**

1. **Never paste a new secret value into this chat.** When the provider reveals a new key, tell me to copy it to clipboard with Cmd+C — I'll handle it from there. If you accidentally see the value in `get_page_text` output, do NOT echo it back.
2. After each phase, give me ONE terminal command to run, then wait for me to type `done`.
3. If a button or element isn't where the steps describe, use `read_page` to describe what you see and ask me to click instead.
4. Phases must run in order. Phase 5 invalidates the current Gmail refresh token; Phase 6 must immediately follow to re-mint.
5. Use a new tab per provider so I can keep my context.

**My setup right now:**
- Terminal.app is already open with cwd at `~/Projects/active/rt-sales-call-agent`
- I'm logged into Cloudflare, Anthropic, Calendly, Spotify, Google as ec@risingtidesent.com (probably — re-prompt me to log in if any session expired)
- The local script `scripts/rotate_from_clipboard.py` is already in place

When you're ready, type:
> Ready. Starting Phase 1 — Cloudflare API Token. Opening dash.cloudflare.com…

Then begin.

---

## Phase 1 — Cloudflare API Token

1. `navigate` to `https://dash.cloudflare.com/profile/api-tokens`
2. `read_page`. If the login screen is shown, pause: tell me "Log in to Cloudflare, then type `done`." Wait for `done`.
3. `find` the row labeled **rt-sales-call-agent** in the token list. If you don't see one with that exact name, look for an existing token tied to Workers and confirm with me: `Found token "<actual name>" — is this the rt-sales-call-agent token? (y/n)`. Wait for me.
4. `click` the three-dot `...` menu in that row.
5. `find` and `click` **Roll**.
6. A confirmation dialog appears. `click` **Roll** again to confirm.
7. A new token is now visible on the success screen, with a **Copy** button next to it.
8. Tell me:
   ```
   📋 Phase 1 — new Cloudflare API token is on screen.
       Click the Copy button on screen (or select the token and Cmd+C).
       Then in Terminal run:
         python3 scripts/rotate_from_clipboard.py CLOUDFLARE_API_TOKEN
       Type "done" to continue.
   ```
9. Wait for `done`.

---

## Phase 2 — Anthropic API Key

1. `navigate` to `https://console.anthropic.com/settings/keys`
2. `read_page`. If login is shown, pause for me to log in.
3. `find` the key named **rt-sales-call-agent**.
4. `click` the three-dot `...` menu on that row.
5. `click` **Delete** (or **Disable** if Delete is hidden). Confirm in any dialog.
6. `find` and `click` the **Create Key** button (usually top right).
7. In the create-key dialog:
   - Name field: type `rt-sales-call-agent`
   - Workspace: leave default (probably "Default" or the RT workspace)
   - Permissions: leave default
   - `click` **Add**
8. The new `sk-ant-...` key is shown on a one-time screen with a Copy button.
9. Tell me:
   ```
   📋 Phase 2 — new Anthropic API key on screen (starts with sk-ant-).
       Click Copy on screen.
       In Terminal run:
         python3 scripts/rotate_from_clipboard.py ANTHROPIC_API_KEY
       Type "done" to continue.
   ```
10. Wait for `done`.

---

## Phase 3 — Calendly Personal Access Token

1. `navigate` to `https://calendly.com/integrations/api_webhooks`
2. `read_page`. Pause for login if needed.
3. Scroll to **Personal Access Tokens** section.
4. `find` the row labeled **rt-sales-call-agent**.
5. `click` **Revoke** on that row. Confirm in the dialog.
6. `click` **Generate New Token**.
7. Name field: type `rt-sales-call-agent`. `click` **Create**.
8. The new token appears — long, starts with `eyJ`. Copy button next to it.
9. Tell me:
   ```
   📋 Phase 3 — new Calendly PAT on screen.
       Click Copy on screen.
       In Terminal run:
         python3 scripts/rotate_from_clipboard.py CALENDLY_PERSONAL_ACCESS_TOKEN
       Type "done" to continue.
   ```
10. Wait for `done`.

---

## Phase 4 — Spotify Client Secret

1. `navigate` to `https://developer.spotify.com/dashboard`
2. Pause for login if needed.
3. `click` the app card titled **RT Sales Call Agent**.
4. `find` and `click` **Settings** (top right of the app page).
5. Scroll to the **Client secret** section.
6. `find` and `click` **View client secret** if needed, then `click` **Rotate client secret** (button label may say "Generate new client secret" or just "Rotate" — pick whichever rotates, not whichever views).
7. Confirm in any dialog. New secret appears.
8. Tell me:
   ```
   📋 Phase 4 — new Spotify Client Secret on screen.
       Select the new secret value and Cmd+C.
       In Terminal run:
         python3 scripts/rotate_from_clipboard.py SPOTIFY_CLIENT_SECRET
       Type "done" to continue.
   ```
9. Wait for `done`.

---

## Phase 5 — Google OAuth Client Secret (⚠ chain to Phase 6)

After this phase, the current Gmail/Drive refresh token stops working. Phase 6 re-mints immediately.

1. `navigate` to `https://console.cloud.google.com/apis/credentials`
2. `read_page`. If the project selector at the top doesn't say **rising-tides-sales-agent**, tell me:
   ```
   The current Google Cloud project is "<name>". I need to switch to rising-tides-sales-agent.
   Click the project selector at the top, pick rising-tides-sales-agent, then type "done".
   ```
   Wait for `done`.
3. Under **OAuth 2.0 Client IDs**, `find` the row for **RT Sales Call Agent**. `click` the client name to open the detail page.
4. On the detail page, scroll to **Client secrets** section.
5. `find` the button — could be labeled **Add Secret**, **Reset Secret**, **Rotate Secret**, or similar.
6. `click` the most rotation-like option. If it's **Add Secret**:
   - The new secret appears alongside the old one.
   - Note both secrets remain active until you delete the old one. Do not delete the old one yet — we need it valid until Phase 6's re-mint succeeds.
7. If it's **Reset Secret**: confirm in the dialog. New secret replaces old immediately.
8. The new secret starts with `GOCSPX-`. Copy button is next to it.
9. Tell me:
   ```
   📋 Phase 5 — new Google OAuth Client Secret on screen (starts with GOCSPX-).
       Click Copy.
       In Terminal run:
         python3 scripts/rotate_from_clipboard.py GMAIL_OAUTH_CLIENT_SECRET
       ⚠ Do NOT close this tab — Phase 6 needs the new secret value on clipboard again later.
       Type "done" to continue.
   ```
10. Wait for `done`.

---

## Phase 6 — Re-mint Gmail / Drive Refresh Token

You'll need the existing GMAIL_OAUTH_CLIENT_ID (unchanged) and the NEW GMAIL_OAUTH_CLIENT_SECRET (just rotated). Pull both from .dev.vars without exposing values in chat.

1. Tell me:
   ```
   Open Terminal. Run:
     pbcopy < /dev/null   # clear clipboard first
     grep ^GMAIL_OAUTH_CLIENT_ID= ~/Projects/active/rt-sales-call-agent/.dev.vars | cut -d= -f2- | pbcopy
   The Client ID is now on your clipboard. Type "done" when ready.
   ```
2. Wait for `done`.
3. `navigate` to `https://developers.google.com/oauthplayground/`
4. `find` and `click` the **gear icon** in the top right.
5. Tick the checkbox labeled **Use your own OAuth credentials**.
6. `click` into the **OAuth Client ID** field and paste (use Cmd+V — clipboard has the Client ID from step 1).
7. Tell me:
   ```
   Now run in Terminal:
     pbcopy < /dev/null
     grep ^GMAIL_OAUTH_CLIENT_SECRET= ~/Projects/active/rt-sales-call-agent/.dev.vars | cut -d= -f2- | pbcopy
   Type "done" when the new Client Secret is on clipboard.
   ```
8. Wait for `done`. `click` into the **OAuth Client secret** field and paste.
9. `click` **Close** on the gear panel.
10. In Step 1 of the playground, `find` and expand **Gmail API v1**. Tick the box for:
    `https://www.googleapis.com/auth/gmail.readonly`
11. Scroll, expand **Drive API v3**. Tick:
    `https://www.googleapis.com/auth/drive.readonly`
12. `click` the **Authorize APIs** button at the bottom of Step 1.
13. A Google sign-in window opens. Tell me:
    ```
    Sign in as ec@risingtidesent.com. After the consent screen, type "done".
    ```
14. After I confirm, on the "Google hasn't verified this app" screen:
    - `click` **Advanced**
    - `click` **Go to RT Sales Call Agent (unsafe)**
    - On the consent screen (Gmail + Drive permission boxes), `click` **Continue**
15. Back in OAuth Playground, Step 2 is now active. `click` **Exchange authorization code for tokens**.
16. The response panel on the right shows JSON including `"refresh_token": "1//..."`.
17. Tell me:
    ```
    📋 Phase 6 — new refresh token is in the JSON response on the right.
        SELECT just the token value (everything between the quotes of "refresh_token": "..." — should start with 1// and be ~100 chars).
        Cmd+C to copy.
        In Terminal run:
          python3 scripts/rotate_from_clipboard.py GMAIL_OAUTH_REFRESH_TOKEN
        Type "done" to continue.
    ```
18. Wait for `done`.

---

## Phase 7 — Redeploy + smoke test

1. Tell me to run, all in one go (Terminal):
   ```
   cd ~/Projects/active/rt-sales-call-agent && \
     eval "$(python3 scripts/load_secrets.py)" && \
     export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && \
     ./node_modules/.bin/wrangler deploy
   ```
   Wait for me to type `deployed`.
2. Then fire the smoke test:
   ```
   curl -sS -X POST "https://rt-sales-call-agent.smathdaddy.workers.dev/test/pre-call" \
     -H "X-Test-Key: rt-test-2026" \
     -H "Content-Type: application/json" \
     --data '{"email":"rotation-check@example.com","name":"Rotation Check","spotifyLink":"https://open.spotify.com/artist/4q3ewBCX7sLwd24euuV69X"}'
   ```
   Tell me: "Wait ~30 seconds, then check your Notion Deals db for a 'Rotation Check' record. Type `verified` once you see it."
3. Wait for `verified`.

---

## Phase 8 — Scrub past Claude transcripts

1. Tell me to run:
   ```
   ~/.claude/scripts/scrub-transcripts.sh
   ```
   This redacts the leaked secret patterns from `~/.claude/projects/*.jsonl`.
2. If the script doesn't exist, tell me:
   ```
   Scrubber not found. Skip this step — transcript file is only readable from your Mac
   anyway, and rotating the keys (which you just did) is the real protection.
   ```

---

## Final summary

After all phases, print:

```
═══════════════════════════════════════════════════
  ROTATION COMPLETE — all 6 leaked keys rolled
═══════════════════════════════════════════════════
  ✅ CLOUDFLARE_API_TOKEN
  ✅ ANTHROPIC_API_KEY
  ✅ CALENDLY_PERSONAL_ACCESS_TOKEN
  ✅ SPOTIFY_CLIENT_SECRET
  ✅ GMAIL_OAUTH_CLIENT_SECRET
  ✅ GMAIL_OAUTH_REFRESH_TOKEN
  ✅ Worker redeployed
  ✅ Smoke test verified
  ✅ Transcripts scrubbed (if scrubber existed)

  All new values: stored in .dev.vars (gitignored) + Cloudflare Secrets.
  Audit log: ~/Projects/active/rt-sales-call-agent/.rotation-log
═══════════════════════════════════════════════════
```

Done.

===END===

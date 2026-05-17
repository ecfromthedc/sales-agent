# Finish Setup — Browser Agent Prompt

Copy everything below `===START===` into Claude in Chrome.

This finishes the 3 remaining unblocks for the RT Sales Call Agent. After it's done, paste the captured refresh token back into terminal Claude with the word `redeploy` and I'll handle the rest (folder ID lookup via Drive API, redeploy, smoke test).

---

===START===

You are finishing the production setup for the `rt-sales-call-agent` Cloudflare Worker that I (Eric) already deployed. Three small unblocks remain. Your job is to drive me through each in order, capture exactly one credential at the end, and report back.

**Hard rules:**
- After each phase, print a clear status line: `✅ Phase N done` or `⚠ Phase N stuck: <what's happening>`.
- Never paste credentials into any third-party site. Show captured values in chat only — I copy them manually.
- If a Google page looks different than these steps describe (UIs drift), describe what you see and ask me which button to click rather than guessing.
- Pause whenever I need to physically authenticate or click "Allow" on a Google screen. Wait for me to type `done` before continuing.

---

## Phase 1 — Re-mint Gmail refresh token with BOTH scopes

The current refresh token only covers `gmail.readonly`. The worker now needs `drive.readonly` too. Re-issue the token with both.

**Pre-step: find my existing OAuth credentials.** Ask me to paste the values for `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` from my `.dev.vars` file. I'll paste them in this chat. Wait for me before continuing.

Then:

1. Open https://developers.google.com/oauthplayground/
2. Click the **gear icon** in the top right.
3. Tick **"Use your own OAuth credentials"**.
4. In the OAuth Client ID field, paste the `GMAIL_OAUTH_CLIENT_ID` I gave you.
5. In the OAuth Client secret field, paste the `GMAIL_OAUTH_CLIENT_SECRET` I gave you.
6. Click **Close** (the gear panel).
7. In the left panel under **Step 1 — Select & authorize APIs**, scroll to find **Gmail API v1**. Expand it. Tick:
   - `https://www.googleapis.com/auth/gmail.readonly`
8. Keep scrolling, find **Drive API v3**. Expand it. Tick:
   - `https://www.googleapis.com/auth/drive.readonly`
9. Both boxes should now show as ticked. Click the blue **Authorize APIs** button at the bottom of Step 1.
10. Google sign-in screen — pause here. Tell me: `Sign in as ec@risingtidesent.com when ready, then type "done".` Wait for me.
11. After I'm signed in, you'll see a warning "Google hasn't verified this app." Click **Advanced**, then **Go to RT Sales Call Agent (unsafe)**, then **Continue** on the consent screen (Gmail + Drive read access boxes should be visible — both should be ticked).
12. Back in OAuth Playground, **Step 2 — Exchange authorization code for tokens** is now active. Click **Exchange authorization code for tokens**.
13. The response panel on the right will show JSON including a `refresh_token` field. Copy the entire refresh token value (starts with `1//`).
14. Report:
    ```
    ✅ Phase 1 done
    NEW_GMAIL_OAUTH_REFRESH_TOKEN=<paste the token here>
    ```

---

## Phase 2 — Enable Google Meet auto-transcription

Workspace Admin setting. Once on, every Meet I host auto-generates a transcript into Drive.

1. Open https://admin.google.com
2. If I'm not signed in, ask me to sign in as the Workspace admin for risingtidesent.com, then `done`.
3. Top-left hamburger menu → **Apps** → **Google Workspace** → **Google Meet**.
4. Click **Meet video settings** (sometimes shown as "Service settings" or "Service status" — pick whichever exposes recording/transcription options).
5. Find the **Recording** section. Tell me what you see — Google has reorganized this UI a few times. We're looking for any combination of:
   - "Let people record their meetings"
   - "Generate transcripts"
   - "Allow transcripts"
   - "Default settings — transcription on/off"
6. Turn ON anything related to **transcripts** or **transcription**. If there's a separate "Default for new meetings: transcribe automatically" toggle, turn that on too.
7. If recording must also be enabled for transcription to work, turn that on as well.
8. Apply the setting to the **All organizational units** or **root org** scope.
9. Click **Save** at the bottom.
10. Report:
    ```
    ✅ Phase 2 done — what was toggled: <list each setting you turned on>
    ```

If the toggles are greyed out, report:
```
⚠ Phase 2 stuck: <describe what's greyed and why>
```
This usually means I need Business Standard or higher — Workspace Business Starter doesn't include transcription. If that's the case, tell me which plan I'm on (visible somewhere on admin.google.com) so I can decide whether to upgrade.

---

## Phase 3 — Verify the Meet Recordings folder

We don't need to create the folder manually — Google creates it the first time a transcript or recording lands in Drive. Just verify Drive is ready.

1. Open https://drive.google.com
2. If I'm not signed in as ec@risingtidesent.com, ask me to switch accounts, then `done`.
3. In the left sidebar, look for a folder named **Meet Recordings**. It may not exist yet if I haven't hosted a recorded/transcribed Meet.
4. If it exists:
   - Open it.
   - Copy the URL from the address bar. It will look like:
     `https://drive.google.com/drive/folders/1aBcDeFgHiJkLmNoPqRsTuVwXyZ`
   - Report:
     ```
     ✅ Phase 3 done — MEET_RECORDINGS_FOLDER_ID=<the part after /folders/>
     ```
5. If it does NOT exist yet:
   - Report:
     ```
     ✅ Phase 3 done — folder does not exist yet; will auto-create after Eric's next Meet.
     ```
   - Tell me: terminal Claude can find it automatically once it exists by querying Drive API — no manual action needed beyond hosting one recorded/transcribed Meet.

---

## Final report

After all three phases, print one consolidated block:

```
=== Setup finish — captured ===

Phase 1: ✅ refresh token re-minted with gmail.readonly + drive.readonly
NEW_GMAIL_OAUTH_REFRESH_TOKEN=<value>

Phase 2: ✅ Meet auto-transcription enabled (or ⚠ stuck reason)
Toggled: <list>

Phase 3: ✅ Meet Recordings folder <found | will be created automatically>
MEET_RECORDINGS_FOLDER_ID=<value or "pending">
```

Then tell me: `Paste this block into terminal Claude with the word "redeploy" and Eric's setup is complete.`

===END===

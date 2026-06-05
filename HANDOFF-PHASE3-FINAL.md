# Phase 3 — Honest Final State (2026-06-05 EOD)

## TL;DR

**The code works. Slack-side event delivery is borked for reasons I cannot diagnose from outside your browser session.** Phase 3 ship-it loop is *fully* exercised via debug HTTP endpoints — your phone has the 4 iMessage attachments from the autonomous test at 02:27 UTC as proof. Real-Slack `:ship_it:` reactions do not currently fire the loop. Two separate Slack apps were tried; both have the same problem. Two paths forward when you're ready.

## What's verified end-to-end (right now, today)

- ✅ `/intake` → Claude API → render → 1080×1350 PNGs → Slack upload (new bot `rtcarousel2`)
- ✅ Edit-note regen via `/debug/simulate-edit-note` with `slide N: ...` parsing
- ✅ `:ship_it:` flow via `/debug/simulate-ship` — lock + summary post + 4 iMessage attachments to `********0570`
- ✅ Draft state lock-protection (subsequent edit notes rejected after ship)
- ✅ Launchd survives reboot
- ✅ Socket Mode connects clean (`num_connections=1` — no contention)
- ✅ 92/92 tests, clippy clean, release build clean

## What does NOT work, and why I think

`reaction_added` and `message.channels` events never reach our Socket Mode session despite:
- Bot has correct scopes (`reactions:read`, `channels:history`, `chat:write`)
- Bot is a member of `#carousels-agent`
- Socket Mode is connected and pinging
- Event Subscriptions configured per manifest

**Apps in play (two of them, both not delivering events to our agent):**

| App ID | App Name | Created | Status |
|---|---|---|---|
| `A0B2GCCECMS` | eric-claude (original) | (pre-existing) | Has Request URL pointing to `eric-claude.risingtidesviral.com/slack/events` — events go there, not Socket Mode |
| `A0B8S37Q6UC` | RT Carousel Agent (new) | 2026-06-05 ~16:00 UTC | Created via manifest, all credentials swapped in. Events still don't deliver. Config pages return 404 in browser. |

**Also discovered during diagnosis:**
- `U0B848B3Y8P` — a THIRD bot also named "rt-carousel" exists in the workspace. Origin unknown. Was the bot Eric's Claude browser accidentally invited the first time.

**Best guess on root cause:** the new app's Event Subscriptions master toggle was never actually enabled (manifest doesn't auto-flip it). I couldn't verify because `https://api.slack.com/apps/A0B8S37Q6UC/event-subscriptions` returns 404 in your Chrome — likely your `api.slack.com` session has expired or the app is owned by a different identity than your current browser auth. The Slack Marketplace page works (different auth domain), so the app definitely exists.

## How to use what works (today)

Until real-Slack reactions are fixed, the working trigger is the debug endpoint:

```bash
# 1. Create a draft (slash command from #carousels-agent OR HTTP intake)
curl -sS -X POST http://127.0.0.1:7677/intake \
  -H 'Content-Type: application/json' \
  -d '{"take":"your topic here","channel":"C0B5X88QQ0K"}'

# 2. Wait ~25s for draft to land in Slack. Get its parent_ts:
grep "carousel uploaded" /tmp/rt-carousel-agent.err | tail -1 | sed 's/\x1b\[[0-9;]*m//g'

# 3. Fire the ship_it flow manually:
curl -sS -X POST http://127.0.0.1:7677/debug/simulate-ship \
  -H 'Content-Type: application/json' \
  -d '{"channel":"C0B5X88QQ0K","parent_ts":"<TS>"}'
# → 4 iMessages on your phone in ~5 sec
```

Edit-note regen via:
```bash
curl -sS -X POST http://127.0.0.1:7677/debug/simulate-edit-note \
  -H 'Content-Type: application/json' \
  -d '{"channel":"C0B5X88QQ0K","parent_ts":"<TS>","text":"slide 2: punchier"}'
```

## Two paths to fix real-Slack reactions (your call, future session)

### Path A — Fix the new app's Event Subscriptions
1. Re-auth at `https://api.slack.com` in your daily Chrome
2. Visit `https://api.slack.com/apps/A0B8S37Q6UC/event-subscriptions` directly
3. If 404 persists, the app might be visible only under a different sign-in — check the OTHER Slack accounts you have
4. Flip "Enable Events" toggle to ON, ensure `message.channels` + `reaction_added` are listed, Save
5. Reinstall the app from "Install App" sidebar
6. Test by reacting `:ship_it:` on any message in `#carousels-agent`

### Path B — Use the OLD app and disable its Request URL
1. Visit `https://api.slack.com/apps/A0B2GCCECMS/event-subscriptions` (this one DID work in your session)
2. Clear the Request URL field OR disable Events temporarily on the other service first
3. The OLD app's Socket Mode session (when active) will receive events
4. Swap env back to OLD app credentials (`/Users/ericcromartie/.cortextos/default/eric-claude-bot.env.bak-20260605-154413` has them)
5. Note: this breaks whatever runs at `eric-claude.risingtidesviral.com` until you re-enable its webhook

## Cleanup queue (your action when you have time)

You asked: "remove the bots we made and aren't using cuz they're confusing the whole process"

To delete a Slack app: go to `https://api.slack.com/apps`, click the app, sidebar → "Delete App" at the very bottom.

| App / Bot | Decision | Notes |
|---|---|---|
| `A0B2GCCECMS` eric-claude | **KEEP** | Used by `eric-claude.risingtidesviral.com` — deleting it kills that service |
| `A0B8S37Q6UC` RT Carousel Agent | **KEEP for now** | Slash command + Socket Mode work; events broken but fixable in Path A above |
| `U0B848B3Y8P` (other rt-carousel) | **DELETE** | A leftover bot with the same name as ours — confusing. Find via Slack settings → Apps & Integrations. Origin unknown. |

If you decide Path B is the way (use old app, kill .risingtidesviral.com webhook), then delete A0B8S37Q6UC too — it's redundant.

## Current creds in env (chmod 600)

```
SLACK_BOT_TOKEN=xoxb-…(new app)
SLACK_APP_TOKEN=xapp-1-A0B8S37Q6UC-…
SLACK_SIGNING_SECRET=55f363…(new app)
RT_CAROUSEL_REPO=/Users/ericcromartie/Projects/active/carousels-agent
RT_IMESSAGE_RECIPIENT=+1<masked>0570
ANTHROPIC_API_KEY=…(unchanged)
```

Backup of pre-swap env at `~/.cortextos/default/eric-claude-bot.env.bak-20260605-154413` if you want to revert.

## Files touched today

```
agent/src/main.rs                      +debug endpoints (list-drafts, simulate-ship, simulate-edit-note)
HANDOFF-PHASE3-FINAL.md                this file (rewritten with today's reality)
~/.cortextos/default/eric-claude-bot.env
                                       +RT_IMESSAGE_RECIPIENT
                                       +RT_CAROUSEL_REPO
                                       SLACK_* swapped to new app creds (backup saved)
1P "Slack rt-carousel-agent app (Phase 3)" (new item teqsqmb2oamp6xroskxvpkxunq)
                                       App ID, bot token, app-level token, signing secret
```

Committed: `092cef2 feat(agent): Phase 3 debug endpoints + autonomous E2E verification`
Branch: `main`

## Honest verdict

Phase 3 the code is done. Phase 3 the "trigger by reacting in Slack" is gated on a Slack-side config issue I can't see into. You have a working manual trigger today (debug endpoint) and a clear path to fix the Slack side when you have energy for it. Sleep on it.

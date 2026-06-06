# Phase 3 — Approve & Ship loop + Alexandria auto-spawn (2026-05-28)

**Session pickup → Phase 2 was shipped (Socket Mode live). Phase 3 wires the missing half: edit-iteratively in Slack, ship via iMessage-to-self.**

---

## 0. Eric's 30-minute morning checklist

Before any of the new features work end-to-end, four short steps:

### 0.1 Grant Full Disk Access to the agent binary (5 min, one-time)

The launchd-spawned agent hangs in `open()` on `course-index.md` because TCC blocks Documents-folder reads from launchd. Foreground runs work because they inherit your shell's permissions.

1. **System Settings → Privacy & Security → Full Disk Access**
2. Click **+** (you may need to unlock with your password)
3. Press `⌘⇧G` and paste `/Users/ericcromartie/bin/rt-carousel-agent`
4. Toggle the entry **ON**
5. Confirm: `pkill -9 -f rt-carousel-agent && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist && sleep 5 && curl -sS http://127.0.0.1:7677/health | python3 -m json.tool`
   - Expect `socket_mode_enabled: true` AND a fresh process surviving past startup.

**Until you do this, the agent is running via `nohup` (PID was 76150 at handoff time).** It works fine — just doesn't auto-restart on reboot.

### 0.2 Set your iMessage recipient (2 min)

```bash
( umask 077 && \
  printf 'RT_IMESSAGE_RECIPIENT=+1XXXXXXXXXX\n' >> ~/.cortextos/default/eric-claude-bot.env )
# Replace +1XXXXXXXXXX with your iCloud phone number (must be registered to iMessage).
# Then restart whichever copy of the agent is running.
```

Without this, `:ship_it:` posts the summary message and skips the iMessage step silently (log says `RT_IMESSAGE_RECIPIENT unset — skipping iMessage step`).

### 0.3 First-time Messages.app automation prompt (1 min)

The first time the agent runs `osascript` against Messages.app, macOS will prompt:

> "Terminal" (or the host process) wants access to control "Messages." Allow?

Click **Allow**. (If you missed it, find it in System Settings → Privacy & Security → Automation → Terminal/your-shell → toggle Messages ON.)

You can pre-arm this by firing a test send first — see §3.3.

### 0.4 Add OAuth scopes + Event Subscriptions to the Slack app (3 min)

Open https://api.slack.com/apps → eric-claude app.

**OAuth & Permissions** → Scopes → Bot Token Scopes, add:
- `channels:history` — read messages in public channels (for thread replies)
- `reactions:read` — see `:ship_it:` reactions
- `groups:history` — if `#carousels` is ever made private
- `im:history` — only if you want to DM the bot to trigger carousels (optional)

`chat:write` is already there. After adding scopes, scroll up and click **Reinstall to Workspace** — Slack will swap the bot token. (Same env var, new value — the script that loads it picks up automatically.)

**Event Subscriptions** → Enable. **Subscribe to bot events:**
- `message.channels`
- `reaction_added`

Save. Socket Mode means there's no Request URL field to worry about — Slack pushes events through the existing WebSocket.

**Refresh the bot token** in 1Password and pipe to env file:

```bash
op read 'op://Rising Tides Production/Slack eric-claude bot/access token' > /tmp/newtok
# Replace the SLACK_BOT_TOKEN line in env file
grep -v '^SLACK_BOT_TOKEN=' ~/.cortextos/default/eric-claude-bot.env > /tmp/env.new
printf 'SLACK_BOT_TOKEN=%s\n' "$(cat /tmp/newtok)" >> /tmp/env.new
mv /tmp/env.new ~/.cortextos/default/eric-claude-bot.env
chmod 600 ~/.cortextos/default/eric-claude-bot.env
rm /tmp/newtok
```

Restart the agent after env changes.

### 0.5 (Optional) Rotate the xapp- token

The `xapp-1-…` token you pasted earlier is in this session's transcript. Recommended: generate a fresh one at https://api.slack.com/apps → eric-claude → Basic Information → App-Level Tokens, swap it into the env file, then run `~/.claude/scripts/scrub-transcripts.sh` to redact the old one from `~/.claude/projects/*.jsonl`.

---

## 1. What's actually built this session

| # | Feature | Status |
|---|---|---|
| #1 | `alexandria-slack-notifier.py` → `POST /alexandria-spawn` | ✓ wired, opt-in via `auto_carousel: true` frontmatter |
| #24a | `chat.postMessage` first, capture `parent_ts` | ✓ refactored `slack.rs` upload path |
| #24b | In-memory draft state store (`drafts.rs`) | ✓ singleton, TTL 24h, 10 unit tests |
| #24c | Socket Mode `events_api` dispatch (`events.rs`) | ✓ routes `reaction_added` + thread `message` |
| #24d | `:ship_it:` reaction → lock + summary + iMessage (`ship.rs`) | ✓ 6 unit tests |
| #24e | Thread reply → edit notes → regen (`regen.rs`) | ✓ slide-targeted parse + general; 11 unit tests |
| #24f | iMessage-to-self via `osascript` (`imessage.rs`) | ✓ 7 unit tests, redaction-safe logging |

**Tests:** 91/91 pass (was 52 in Phase 2). `cargo clippy --all-targets -- -D warnings` clean. `cargo build --release` clean.

**New modules** in `agent/src/`: `drafts.rs`, `events.rs`, `imessage.rs`, `regen.rs`, `ship.rs`. Plus refactors to `config.rs`, `pipeline.rs`, `slack.rs`, `socket_mode.rs`, `lib.rs`.

---

## 2. How the new flow works end-to-end

1. **Trigger** — any of the four surfaces: `/carousel-build <topic>` in Slack, natural-phrase via the `rt-carousel-build` skill, `POST /intake`, or `POST /alexandria-spawn` (now also auto-fired by the slack-notifier).
2. **Draft + render + post** — same as Phase 2, but `pipeline.rs` now calls `chat.postMessage` first to capture `parent_ts`, then attaches PNGs into that thread. The draft + PNG paths get registered into `drafts::store()` keyed by `(channel, parent_ts)`.
3. **You iterate in the thread:**
   - Reply with `slide 3: tighten the hook` → regenerates with edit notes focused on slide 3. New PNGs land in the same thread.
   - Reply without a slide prefix → general edit note applied to the whole arc. Full re-gen.
   - Edit notes accept `slide N:`, `Slide N —`, `sN:`, `#N` shorthand.
4. **You ship:** react `:ship_it:` (or `:white_check_mark:`, `:heavy_check_mark:`, `:+1:`, `:rocket:`) on the bot's draft message. Agent:
   - Locks the draft (no more edit-note regens accepted).
   - Posts a `🔒 ready to ship` summary in the thread with the caption text in a code block (copy target).
   - iMessages the 4 PNGs + caption to your phone (if `RT_IMESSAGE_RECIPIENT` is set).
5. **You add the song:** Messages app → tap-and-hold any slide → Save All → IG → New Post → carousel from Recents → caption paste → audio → ship.

---

## 3. Verify each feature (after §0 is done)

### 3.1 alexandria-spawn auto-fire

```bash
# Dry-run smoke test
python3 ~/Projects/active/rt-agents/alexandria-slack-notifier.py --dry-run \
  "$HOME/Documents/Obsidian Vault/Alexandria/Content Strategy/_test/test-alexandria-entry.md"
# Expect: "[dry-run] would fire carousel spawn → http://127.0.0.1:7677/alexandria-spawn (verdict=PUBLISHED)"
```

For the real path, the notifier already runs nightly via launchd over new Alexandria entries. Add `auto_carousel: true` to a real entry's frontmatter, then wait for the cron OR re-run the notifier manually against it.

A test draft already in flight from §3.1's test entry: should be in `#carousels` from around 05:35 UTC, slug `the-loop-that-fires-itself`. Feel free to delete or use as the first real `:ship_it:` test target.

### 3.2 :ship_it: ship flow

1. Fire any carousel via slash command, e.g. `/carousel-build Mon Rovia 1.8M streams` in `#carousels`.
2. Wait ~22s for the draft to land.
3. React `:ship_it:` on the bot's draft message (the one with the "*Pre-release curiosity* · vol. 02 ..." caption — NOT one of the individual slide images).
4. Within ~3s the agent should post a `🔒 ready to ship` reply in the thread.
5. If iMessage is configured, your phone gets 4 PNGs + a caption text from "you" (iMessage-to-self).

### 3.3 Edit-notes regen

In a fresh thread with an unlocked draft, reply:

> slide 3: tighten the hook, make it 8 words max

Within ~22s a fresh set of 4 PNGs lands in the same thread. The new draft replaces the prior one in `drafts::store()` at the same `(channel, parent_ts)` key.

### 3.4 iMessage manual smoke test

If you want to pre-arm the Automation TCC permission before the first real ship_it:

```bash
echo 'tell application "Messages"
    set targetService to 1st account whose service type = iMessage
    set targetBuddy to participant "+1XXXXXXXXXX" of targetService
    send "rt-carousel-agent test ping" to targetBuddy
end tell' | osascript
```

First run prompts for Automation permission. Approve it. Subsequent runs (including from the agent) work silently.

---

## 4. Known limitations / future work

- **Targeted slide regen is currently full regen.** When you say `slide 3: tighten`, the LLM is told to focus on slide 3, but ALL slides regenerate (and all 4 PNGs re-render + re-upload). A surgical "render only slide N, replace only that PNG" path is doable but needs surgery in `generator.rs` (one-slide prompt) + `render.rs` (per-slide screenshot). ~3-4 hours of work for the reduced thrash. Acceptable v1 cost: ~22s + 4 PNG re-uploads per edit instead of ~10s + 1 PNG.
- **State is in-memory.** A restart loses the ability to edit drafts that were in flight at restart time. The PNGs + Slack thread survive — you just have to re-fire the carousel if you need to iterate further. Upgrade to SQLite is straightforward (replace the inner map in `drafts.rs`) if this bites.
- **iMessage attachment is "send file" not "compose-then-add."** Messages sends each PNG as its own message + a text message with the caption. You'll see 5 separate messages in the thread on your phone. Acceptable trade for a stable scripting surface.
- **No IG publish.** Drafts via Graph API would be cleaner but Meta doesn't expose "save to mobile-app drafts" — see §6 of the session log for why we're not pursuing it.
- **Reactions are case-sensitive.** Slack uses canonical reaction names. The handler accepts the 5 in `SHIP_REACTIONS`; if you want different ones, edit `events.rs:14`.

---

## 5. Files touched this session

```
agent/Cargo.toml                       (no changes — all new modules use existing deps)
agent/src/config.rs                    +imessage_recipient (env: RT_IMESSAGE_RECIPIENT)
agent/src/drafts.rs                    NEW — singleton draft state store w/ TTL
agent/src/events.rs                    NEW — events_api dispatch (reaction + message)
agent/src/imessage.rs                  NEW — osascript-driven Messages.app send
agent/src/lib.rs                       +drafts, events, imessage, regen, ship
agent/src/pipeline.rs                  drafts::store().register() on successful upload;
                                       parent_ts logging instead of thread_ts
agent/src/regen.rs                     NEW — edit-note parser + apply_edit_note
agent/src/ship.rs                      NEW — :ship_it: handler (lock + summary + iMessage)
agent/src/slack.rs                     UploadResult.thread_ts → parent_ts (always populated);
                                       chat.postMessage adds thread-root capture;
                                       post_thread_message public wrapper
agent/src/socket_mode.rs               events_api stub replaced with real dispatch into events::

~/Projects/active/rt-agents/alexandria-slack-notifier.py
                                       +fire_carousel_spawn (opt-in via frontmatter)
                                       +RT_CAROUSEL_AGENT_URL env override

~/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist
                                       WorkingDirectory: ~ (was: repo) — TCC workaround
                                       (see §0.1 for the real fix)
```

---

## 6. Where I am at handoff time

- **Build:** `cargo build --release` clean. `cargo test`: 91/91 pass. `cargo clippy -- -D warnings`: clean.
- **Binary:** deployed to `~/bin/rt-carousel-agent` (signed with stable identifier `com.risingtides.rt-carousel-agent`).
- **Running process:** `nohup` foreground at PID ≈76150 (run `pgrep -f rt-carousel-agent` to confirm). All four trigger surfaces live, Socket Mode handshake confirmed via `/health`.
- **launchd:** bootout'd because TCC blocks Documents reads under launchd. Re-enable per §0.1 once Full Disk Access is granted.
- **Test entry:** `Alexandria/Content Strategy/_test/test-alexandria-entry.md` exists and triggered the first auto-spawn at 05:35Z (slug `the-loop-that-fires-itself`). Delete the entry + the resulting `preview-the-loop-that-fires-itself.html` if you don't want them around.

---

## 7. Things explicitly NOT done

- ❌ MCP server interface (#20) — still pending, low priority.
- ❌ PDF bundler (#15) — `printpdf` is in deps but unused. ~30 min when needed.
- ❌ Failed-draft retry surface (#25) — banned-phrase drops are still silent.
- ❌ Per-slide targeted regen (deferred — see §4).
- ❌ IG Graph API publish — Meta doesn't expose mobile-Drafts API; not pursuing.
- ❌ Postiz/Buffer wiring — you said you'd post manually; no scheduler in the loop.

---

## 8. First commands when you sit down

```bash
# 1. Sanity-check what's running
ps aux | grep rt-carousel-agent | grep -v grep
curl -sS http://127.0.0.1:7677/health | python3 -m json.tool

# 2. Tail logs (split to two tabs)
tail -f /tmp/rt-carousel-agent.err
tail -f /tmp/rt-carousel-agent.log

# 3. Fire a test
# (in Slack) /carousel-build pre-release curiosity
# (or)
curl -sS -X POST http://127.0.0.1:7677/intake \
  -H 'Content-Type: application/json' \
  -d '{"take":"pre-release curiosity is the only campaign that matters","channel":"C0B5X88QQ0K"}' | python3 -m json.tool
```

If `/health` doesn't respond: the `nohup` process died. Re-launch with:
```bash
nohup ~/bin/rt-carousel-agent > /tmp/rt-carousel-agent.log 2> /tmp/rt-carousel-agent.err < /dev/null &
disown $!
```

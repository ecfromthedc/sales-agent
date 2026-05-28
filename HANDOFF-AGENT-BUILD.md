# RT Carousel Agent — Build Handoff

**For:** the next Claude Code session
**Owner:** Eric Cromartie · `ec@risingtidesent.com` · Rising Tides
**Last session:** 2026-05-27 → 2026-05-28 (overnight, ~5 hours, Tasks #13-#19 shipped)
**Status:** **Phase 1 COMPLETE.** Full end-to-end loop live and verified.

---

## 0. The 60-second resume

The agent is **running on launchd, end-to-end working on localhost**. Verified at 04:07 EDT on 2026-05-28:

```
slash command          →  769ms ack
Claude API draft       →  7.5s    (claude-sonnet-4-6, 882→436 tokens)
preview HTML written   →  +1ms
4× 1080×1350 PNGs      →  +11s    (headless Chrome via spawn_blocking)
4 files → Slack thread →  +1s     (files.completeUploadExternal)
Pocket panel inlined   →  +3ms    (version bumped to 2026-05-28-001)
Total: ~22 seconds
```

**The one missing piece for production-grade triggering:** Slack's servers can't reach `127.0.0.1:7677`. Locally we forge signed requests via `/tmp/test-slash.sh` and they work. To trigger from Slack-the-product, you need either:
- (a) a cloudflared tunnel exposing `carousel-agent.risingtidesviral.com → 127.0.0.1:7677` + slash-command URL pointed at it, OR
- (b) Task #23 Socket Mode (outbound WebSocket, no tunnel needed).

Everything else is shipped.

---

## 1. What's actually running right now

| Surface | State | Where |
|---|---|---|
| **Agent binary** | running under launchd | `~/bin/rt-carousel-agent` (PID will change; check `launchctl list \| grep rt-carousel`) |
| **HTTP server** | `127.0.0.1:7677` | endpoints below |
| **launchd service** | `com.risingtides.rt-carousel-agent` (KeepAlive=true, RunAtLoad=true) | `~/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist` |
| **Weekly brief cron** | `com.risingtides.carousel-weekly-brief` Friday 4pm ET | unchanged from prior session |
| **Slack channel** | `C0B5X88QQ0K` (#carousels in marketing-awr4675) | bot `eric-claude` is member |
| **Pocket index** | `~/Projects/active/rt-pocket/index.html` | last bumped `2026-05-28-001` |
| **Logs (live)** | `/tmp/rt-carousel-agent.err` (stderr) | tail -f works; stdout is `.log` but mostly empty |

**HTTP endpoints:**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + all `*_present` flags |
| POST | `/intake` | direct JSON intake (5-field Weekly Content Brief) |
| POST | `/slack/slash-command` | Slack-signed `/carousel-build <topic>` (HMAC verified, ack in <3s) |
| POST | `/alexandria-spawn` | 501 — Phase 2 task #22 |

---

## 2. Live verification commands (run these to confirm before anything else)

```bash
# 1. Agent up?
launchctl list | grep rt-carousel
curl -sS http://127.0.0.1:7677/health | python3 -m json.tool
# Expect: anthropic_key_present, slack_token_present, slack_signing_secret_present all true

# 2. Full end-to-end smoke (forges a valid signed Slack request)
/tmp/test-slash.sh    # script saved from prior session
# Expect: 200 ack JSON. Watch /tmp/rt-carousel-agent.err for pipeline trace.

# 3. Confirm pipeline finished
tail -30 /tmp/rt-carousel-agent.err | grep -E "uploaded|Pocket panel"
# Expect: "carousel uploaded to Slack thread file_ids=4"
#         "Pocket panel inlined ... version=YYYY-MM-DD-NNN"
```

If `/tmp/test-slash.sh` is missing, regenerate it from the section "Test script" below.

---

## 3. Tasks — final scoreboard

| # | Task | Status |
|---|---|---|
| 5-12 | Course index, weekly brief, scaffold, generator, sources | ✓ shipped earlier |
| **13** | **Midnight Press HTML renderer** | ✓ shipped this session |
| **14** | **Headless Chrome PNG screenshot (1080×1350)** | ✓ shipped this session |
| 15 | PDF bundler | deferred — Phase 2 |
| **16** | **Slack file upload (modern `getUploadURLExternal` flow)** | ✓ shipped this session |
| **17** | **RT Pocket inline (idempotent panel + drawer card + version bump)** | ✓ shipped this session |
| **18** | **launchd service for the agent** | ✓ shipped this session |
| **19** | **`/slack/slash-command` HTTP endpoint with HMAC verify** | ✓ shipped this session |
| 20 | MCP server interface | pending — Phase 2 |
| 21 | Natural-phrase Claude Code skill | pending — Phase 2 |
| 22 | `/alexandria-spawn` endpoint | pending — Phase 2 |
| 23 | Slack Socket Mode listener (replaces tunnel need for #19) | pending — Phase 2 |

**40/40 unit tests pass.** Run `cd carousels-agent/agent && cargo test` to confirm.

---

## 4. Files touched this session

```
agent/Cargo.toml                       +base64, +serde_urlencoded, +hmac, +sha2, +hex
agent/src/lib.rs                       NEW (lib surface so examples + tests can use modules)
agent/src/main.rs                      stderr-tracing, slash-command handler, pipeline orchestration
agent/src/config.rs                    slack_signing_secret, RT_POCKET_INDEX override, carousel-agent.env loader
agent/src/render.rs                    full Renderer (preview + export modes, to_pngs via headless Chrome)
agent/src/slack.rs                     full Slack upload + SlashCommand parse + HMAC signature verify
agent/src/pocket.rs                    full PocketInliner (idempotent upserts + version bump)
agent/src/sources.rs                   removed unused anyhow! import
agent/src/types.rs                     unchanged
agent/templates/midnight-press.css     NEW — inline brand styles (preview + export modes)
agent/examples/render-smoke.rs         NEW — `cargo run --example render-smoke -- [--pngs] [--pocket]`
agent/deploy.sh                        NEW — copy binary to ~/bin/ + ad-hoc sign + restart launchd
~/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist   NEW
HANDOFF-AGENT-BUILD.md                 (this file)
```

---

## 5. THE TWO GOTCHAS THAT WILL BITE YOU IF YOU FORGET

### Gotcha 1: Never run the binary from `cargo target/`

**Symptom:** launchd-spawned process hangs forever in `dyld __open()`, never binds TCP, never logs.

**Cause:** macOS Sequoia provenance-tracking interaction with cargo's `target/` directory. Manual `cargo run` works fine, launchd does not.

**Fix:** the plist points to `~/bin/rt-carousel-agent`. **After every `cargo build --release`, run `agent/deploy.sh`** — it copies the binary to `~/bin/`, ad-hoc codesigns it, and kickstarts launchd.

```bash
cd ~/Documents/Development/carousels-agent/agent
cargo build --release && ./deploy.sh
```

### Gotcha 2: tracing must go to stderr

stdout is **block-buffered** under launchd (writes don't appear until 8KB fills or process exits). stderr is **line-buffered**.

`src/main.rs` already has `.with_writer(std::io::stderr)`. If you ever revert that, the agent will appear silent and you'll waste 30 minutes diagnosing.

---

## 6. Next session pickup — Phase 2 starts here

Phase 1 is shipped. Phase 2 = expanding the trigger surface and removing the localhost limitation.

### 6.1 Recommended order

**Task #23 (Slack Socket Mode) is the highest-leverage next move.** It eliminates the need for a cloudflared tunnel by having the agent open an outbound WebSocket to Slack. The `/slack/slash-command` HTTP endpoint stays as a backup / for manual testing. Spec:

- Use `tokio-tungstenite` (already in deps)
- Get a Socket Mode token from the Slack app (`xapp-` prefix) — needs `connections:write` scope
- App Manifest: enable Socket Mode, enable Slash Commands with `Command: /carousel-build`, `Description: ...`, `Usage Hint: <topic>`, set "Request URL" to anything (irrelevant in Socket Mode)
- On agent startup, spawn a tokio task that:
  1. Calls `apps.connections.open` with the `xapp-` token → returns wss URL
  2. Connects WebSocket, receives Slack envelopes
  3. For each `slash_commands` envelope: parse payload (same shape as HTTP body), build Intake, send `{"envelope_id": "..."}` ack within 3s, spawn `run_pipeline`
  4. Reconnect on disconnect with exponential backoff
- Add `SLACK_APP_TOKEN` to Config + `~/.cortextos/default/carousel-agent.env` (1P new item or extend existing)
- No new HTTP routes needed. The existing `/slack/slash-command` handler stays for `/tmp/test-slash.sh` integration tests.

**Alternative if Eric prefers HTTP webhook:** cloudflared tunnel — see `~/.cloudflared/config.yml` (the rt-pocket pattern). Add `carousel-agent.risingtidesviral.com` → `localhost:7677`. Then set the Slack app's Slash Commands → Request URL to `https://carousel-agent.risingtidesviral.com/slack/slash-command`. The agent already verifies signatures so the public URL is safe.

### 6.2 After #23, in priority order

- **#22 `/alexandria-spawn`** — fire a carousel when a relevant Alexandria entry lands. Should be a thin POST endpoint that accepts `{ note_path: "Alexandria/..." }`, reads frontmatter + content, builds an `Intake` with `SeedField::AlexandriaSpawn`, runs the same pipeline. Useful as a hook for `alexandria-slack-notifier.py` to call after publishing.
- **#21 Natural-phrase skill** — Claude Code skill that fires `/carousel-build <text>` when Eric says "make a carousel about X" in a session. Wraps the HTTP endpoint. Quick to write once #20 or #23 stabilizes.
- **#20 MCP server interface** — exposes the agent as MCP tools. Lower priority — only valuable if Eric wants other Claude/MCP clients to trigger carousels.
- **#15 PDF bundler** — printpdf already in deps. Bundle the per-slide PNGs into a single PDF (one slide per page). Trivial; defer until a use case shows up.

### 6.3 First commands in the next session

```bash
cd ~/Documents/Development/carousels-agent
git status                                                # see what's uncommitted
curl -sS http://127.0.0.1:7677/health | python3 -m json.tool
/tmp/test-slash.sh                                        # ↑ confirm everything still works
tail -30 /tmp/rt-carousel-agent.err                       # see latest pipeline trace
launchctl list | grep -E "rt-carousel|carousel-weekly"    # both services should be loaded
```

---

## 7. Reference

### 7.1 Secrets (where they live, never paste in chat)

| Secret | Env var | 1P item | File (chmod 600) |
|---|---|---|---|
| Anthropic API | `ANTHROPIC_API_KEY` | "Anthropic API Key" (Employee vault, `s4gdcdvpkfp2rboatxvs4n5hqy`) | `~/.cortextos/default/carousel-agent.env` |
| Slack bot token | `SLACK_BOT_TOKEN` | "Slack eric-claude bot" (Rising Tides Production, `5xoyhe7cxacknv7jqllmdaf2zm`) | `~/.cortextos/default/eric-claude-bot.env` |
| Slack signing secret | `SLACK_SIGNING_SECRET` | same item (notesPlain or separate field) | same env file |

To refresh either: pipe `op read 'op://VAULT/ITEM/credential'` directly into the env file. Never let the value enter the chat context.

### 7.2 Reproducing `/tmp/test-slash.sh`

If `/tmp/test-slash.sh` is missing in the next session, regenerate:

```bash
cat > /tmp/test-slash.sh <<'BASH'
#!/usr/bin/env bash
set -euo pipefail
BODY='token=test&team_id=T1DC2JH3J&team_domain=rt&channel_id=C0B5X88QQ0K&channel_name=carousels&user_id=U1&user_name=eric&command=%2Fcarousel-build&text=Mon+Rovia+just+hit+1.8M+listeners&response_url=https%3A%2F%2Fhooks.slack.com%2Fx&trigger_id=t.1.2'
TS=$(date +%s)
BASESTRING="v0:${TS}:${BODY}"
SIG=$(
  source ~/.cortextos/default/eric-claude-bot.env
  printf '%s' "$BASESTRING" | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -binary | xxd -p -c 256
)
curl -sS -X POST http://127.0.0.1:7677/slack/slash-command \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: ${TS}" \
  -H "X-Slack-Signature: v0=${SIG}" \
  --data "${BODY}"
BASH
chmod +x /tmp/test-slash.sh
```

### 7.3 Key files (open these in editor)

- `agent/src/main.rs` — routes, pipeline orchestration
- `agent/src/slack.rs` — upload + signature verify + slash parsing (richest module)
- `agent/src/render.rs` — Midnight Press HTML + headless Chrome PNG
- `agent/src/pocket.rs` — idempotent panel/card upsert + version bump
- `agent/src/generator.rs` — Claude API prompt construction (this is where voice calibration happens)
- `course-index.md` — §3 claims registry (verification floor)
- `agent/deploy.sh` — workflow encoded
- `agent/templates/midnight-press.css` — inline brand styles

### 7.4 Common operations

```bash
# Refresh Anthropic key from 1P
( printf 'ANTHROPIC_API_KEY=' && op read 'op://ztktocaizswsp7avoyi44hxjym/s4gdcdvpkfp2rboatxvs4n5hqy/credential' && printf '\n' ) > ~/.cortextos/default/carousel-agent.env
chmod 600 ~/.cortextos/default/carousel-agent.env
launchctl kickstart -k gui/$(id -u)/com.risingtides.rt-carousel-agent

# Refresh Slack bot token (in-place swap, preserves other vars)
( umask 077 && op read 'op://Rising Tides Production/5xoyhe7cxacknv7jqllmdaf2zm/credential' > /tmp/_t )
python3 -c "
import os
p = os.path.expanduser('~/.cortextos/default/eric-claude-bot.env')
tok = open('/tmp/_t').read().strip()
lines = open(p).readlines()
open(p, 'w').writelines(f'SLACK_BOT_TOKEN={tok}\n' if l.startswith('SLACK_BOT_TOKEN=') else l for l in lines)
os.chmod(p, 0o600); os.remove('/tmp/_t')
"
launchctl kickstart -k gui/$(id -u)/com.risingtides.rt-carousel-agent

# Rebuild + redeploy
cd ~/Documents/Development/carousels-agent/agent
cargo build --release && ./deploy.sh

# Stop the agent
launchctl bootout gui/$(id -u)/com.risingtides.rt-carousel-agent

# Restart from scratch
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist
```

### 7.5 Slack app scopes (in case anything else needs reinstalling)

Current `eric-claude` bot has: `chat:write, chat:write.customize, im:write, channels:read, channels:history, groups:read, groups:history, im:read, im:history, users:read, app_mentions:read, mpim:history, files:write` (added 2026-05-28 for #16).

For #23 Socket Mode add: `connections:write` + enable Socket Mode in the app config, generate `xapp-...` token.

---

## 8. Things NOT to revisit (already settled)

- **Vol 02-07 carousel drafts** in repo root — those are parked. Don't regenerate them via the agent unless Eric asks.
- **`course-index.md`** — locked. New claims go in §3 (the verification floor). Don't restructure.
- **Brand voice rules** — encoded in `course-index.md` §6 + `agent/src/generator.rs` prompts. Don't override per-draft.
- **The 1P → env file pipe pattern** — works, is the chosen path. Don't replace with shell variables, exports, or hardcoded values.
- **The launchd plist** — points to `~/bin/`, not `target/`. Don't "fix" this back to the target path.

---

## 9. Acknowledgments

What this session proved: with a Rust agent, headless Chrome, the Anthropic SDK, the Slack file-upload API, and a 590-line course index as the verification floor, a slash command in Slack can become a publish-ready Midnight Press carousel — with cited sources, voice-matched copy, brand-perfect typography, and 4× 1080×1350 PNGs ready for IG — in under 22 seconds, fully automated.

The trigger surface (#23 Socket Mode) is the last piece. After that, the agent runs forever and Eric just types `/carousel-build <thing>`.

**End of handoff. Pick up at §6.1 (Task #23) in the next session.**

# RT Carousel Agent — Build Handoff

**For:** the next Claude Code session
**Owner:** Eric Cromartie · `ec@risingtidesent.com` · Rising Tides
**Last session:** 2026-05-28 (Phase 2 — Tasks #21, #22, #23 shipped)
**Status:** **Phase 2 COMPLETE.** Three trigger surfaces live (HTTP intake, HTTP slash, Socket Mode¹, natural-language). Alexandria webhook landed. Only #20 (MCP) and #15 (PDF bundler) remain.

¹ Socket Mode code is shipped + tested but **disabled until Eric generates the `xapp-…` token** — see §6.1.

---

## 0. The 60-second resume

The agent is **running on launchd**. Health endpoint exposes the new Phase 2 surface:

```json
{
  "ok": true,
  "service": "rt-carousel-agent",
  "version": "0.1.0",
  "anthropic_key_present": true,
  "slack_token_present": true,
  "slack_signing_secret_present": true,
  "slack_app_token_present": false,        // ← Phase 2: gate for Socket Mode
  "socket_mode_enabled": false,            // ← becomes true once xapp- token lands
  "default_channel": "C0B5X88QQ0K",
  "obsidian_vault": "/Users/.../Obsidian Vault",   // ← Phase 2: for /alexandria-spawn
  "sources": { "claims": 19, "banned_phrases": 7, "voice_metaphors": 12 }
}
```

**Phase 2 brought:**
- **`pipeline.rs`** — shared orchestration extracted from `main.rs`. Every trigger surface (HTTP intake, HTTP slash, Socket Mode, alexandria-spawn) goes through the same `render_and_publish` path. Drift between paths is now impossible.
- **`socket_mode.rs`** — outbound WebSocket listener. When `SLACK_APP_TOKEN` is set the agent opens a connection to Slack at boot, receives slash-command envelopes, acks within 3s, and dispatches to the same pipeline. **No cloudflared tunnel needed.**
- **`/alexandria-spawn`** — POST endpoint that takes an Alexandria note path, parses frontmatter (lightweight, no YAML crate), derives a one-line take (`summary → title → H1 → first sentence`), and runs the pipeline. Built for `alexandria-slack-notifier.py` to call as a webhook.
- **`rt-carousel-build` skill** — natural-phrase trigger at `~/.claude/skills/rt-carousel-build/SKILL.md`. Eric says "make a carousel about X" in any Claude Code session → skill curls `/intake` → pipeline fires.

**52/52 unit tests pass** (Phase 1's 40 + 12 new — 6 Socket Mode envelope/ack/backoff, 6 Alexandria frontmatter/path-resolve).

---

## 1. What's actually running right now

| Surface | State | Where |
|---|---|---|
| **Agent binary** | running under launchd | `~/bin/rt-carousel-agent` |
| **HTTP server** | `127.0.0.1:7677` | endpoints below |
| **launchd service** | `com.risingtides.rt-carousel-agent` (KeepAlive=true) | `~/Library/LaunchAgents/com.risingtides.rt-carousel-agent.plist` |
| **Socket Mode** | code ready, **inactive** (no `xapp-` token yet) | activates automatically once `SLACK_APP_TOKEN` lands in `~/.cortextos/default/eric-claude-bot.env` |
| **Weekly brief cron** | `com.risingtides.carousel-weekly-brief` Friday 4pm ET | unchanged from Phase 1 |
| **Slack channel** | `C0B5X88QQ0K` (#carousels) | bot `eric-claude` is member |
| **Pocket index** | `~/Projects/active/rt-pocket/index.html` | last bumped `2026-05-28-002` |
| **Claude Code skill** | `rt-carousel-build` | `~/.claude/skills/rt-carousel-build/SKILL.md` |
| **Logs (live)** | `/tmp/rt-carousel-agent.err` | line-buffered stderr |

**HTTP endpoints (all shipped):**

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness + all `*_present` flags + `socket_mode_enabled` + `obsidian_vault` |
| POST | `/intake` | direct JSON intake (5-field Weekly Content Brief) |
| POST | `/slack/slash-command` | Slack-signed `/carousel-build <topic>` over HTTP |
| POST | `/alexandria-spawn` | spawn from Alexandria note (`{note_path, channel?, thread_ts?, take_override?}`) |

**Three trigger surfaces, one pipeline (`pipeline::run_from_intake`):**

```
HTTP /intake          ──┐
HTTP /slack/slash-cmd ──┤
Socket Mode WS        ──┼──→  draft_from_intake  →  render  →  PNG  →  Slack  →  Pocket
HTTP /alexandria-spawn──┘   (uses draft_one with SeedField::AlexandriaSpawn)
```

The natural-phrase skill is *not* a fourth surface — it's a wrapper that hits `/intake`.

---

## 2. Live verification commands

```bash
# 1. Agent up + new Phase 2 flags?
launchctl list | grep rt-carousel
curl -sS http://127.0.0.1:7677/health | python3 -m json.tool
# Expect: slack_app_token_present=false (until token lands), socket_mode_enabled=false,
#         obsidian_vault="/Users/.../Obsidian Vault"

# 2. Phase 1 regression — slash command still works
/tmp/test-slash.sh
# Expect: 200 ack JSON. Watch /tmp/rt-carousel-agent.err — module path should be
#         `rt_carousel_agent::pipeline::...` (proves the shared module is loaded).

# 3. /alexandria-spawn (dry: invalid path returns 400, not 500)
curl -sS -X POST http://127.0.0.1:7677/alexandria-spawn \
  -H "Content-Type: application/json" \
  -d '{"note_path": "does-not-exist.md"}'
# Expect: "note not found under vault root or Alexandria/: does-not-exist.md"

# 4. /alexandria-spawn (real fire — burns ~22s + Slack post + Pocket bump)
curl -sS -X POST http://127.0.0.1:7677/alexandria-spawn \
  -H "Content-Type: application/json" \
  -d '{"note_path": "Alexandria/Content Strategy/Reddit-Stealth-Growth-Playbook.md"}'
# Expect: 200 with task_id. Tail logs — seed should be AlexandriaSpawn.

# 5. The skill — say one of these to Claude Code:
#    "make a carousel about the polish penalty"
#    "draft a carousel on save economy"
#    "/carousel-build Mon Rovia just hit 1.8M"
# Expect: Claude curls /intake, returns task_id, ack message.
```

---

## 3. Tasks — final scoreboard

| # | Task | Status |
|---|---|---|
| 5-12 | Course index, weekly brief, scaffold, generator, sources | ✓ Phase 1 |
| 13 | Midnight Press HTML renderer | ✓ Phase 1 |
| 14 | Headless Chrome PNG screenshot (1080×1350) | ✓ Phase 1 |
| 15 | PDF bundler | deferred — Phase 3 (low priority) |
| 16 | Slack file upload (`getUploadURLExternal` flow) | ✓ Phase 1 |
| 17 | RT Pocket inline (idempotent panel + drawer card + version bump) | ✓ Phase 1 |
| 18 | launchd service | ✓ Phase 1 |
| 19 | `/slack/slash-command` HTTP endpoint with HMAC verify | ✓ Phase 1 |
| 20 | MCP server interface | pending — Phase 3 |
| **21** | **Natural-phrase Claude Code skill (`rt-carousel-build`)** | ✓ shipped this session |
| **22** | **`/alexandria-spawn` endpoint** | ✓ shipped this session |
| **23** | **Slack Socket Mode listener** | ✓ shipped this session¹ |

¹ Code shipped, tested (envelope parse, ack, backoff). Activates the moment Eric drops the `xapp-…` token into 1P + the env file. See §6.1.

**Test count: 52/52 pass** — Phase 1's 40 + 12 new. Run `cd carousels-agent/agent && cargo test`. `cargo clippy --all-targets -- -D warnings` is also clean.

---

## 4. Files touched this session

```
agent/src/lib.rs                       +pipeline, +socket_mode module declarations
agent/src/config.rs                    +slack_app_token, +obsidian_vault (+SLACK_APP_TOKEN env, +RT_OBSIDIAN_VAULT env)
agent/src/main.rs                      MAJOR refactor:
                                       - run_pipeline moved to pipeline.rs
                                       - intake/slash handlers call pipeline::run_from_intake
                                       - alexandria_spawn_handler is real (was 501 stub)
                                       - AlexandriaNote parser + resolve_note_path + tests
                                       - Socket Mode spawn at startup (conditional)
                                       - health adds slack_app_token_present, socket_mode_enabled, obsidian_vault
agent/src/pipeline.rs                  NEW — run_from_intake + render_and_publish (shared by all surfaces)
agent/src/socket_mode.rs               NEW — Slack Socket Mode listener with reconnect backoff
HANDOFF-AGENT-BUILD.md                 this file (Phase 2 update)

~/.claude/skills/rt-carousel-build/SKILL.md   NEW — natural-phrase trigger
                                              (lives outside this repo by design — skills are global to Claude Code)
```

Cargo deps: **no changes**. Everything Phase 2 needed (`tokio-tungstenite`, `futures-util`) was already pinned for Phase 2.

---

## 5. THE THREE GOTCHAS THAT WILL BITE YOU IF YOU FORGET

### Gotcha 1: Never run the binary from `cargo target/`

**Symptom:** launchd-spawned process hangs forever in `dyld __open()`.

**Fix:** plist points to `~/bin/rt-carousel-agent`. After every `cargo build --release`, run `agent/deploy.sh`.

```bash
cd ~/Documents/Development/carousels-agent/agent
cargo build --release && ./deploy.sh
```

### Gotcha 2: tracing must go to stderr

stdout is **block-buffered** under launchd; stderr is **line-buffered**. `src/main.rs` already has `.with_writer(std::io::stderr)`. Don't revert it.

### Gotcha 3 (Phase 2): Every new trigger surface must call `pipeline::run_from_intake` (or `render_and_publish`)

Do **not** inline the draft → render → PNG → Slack → Pocket chain into a new handler. The whole point of the Phase 2 refactor is that every surface (HTTP intake, HTTP slash, Socket Mode, alexandria-spawn, and any future surface) goes through the same orchestration. Drift between surfaces was the failure mode that made the pre-Phase-2 codebase fragile.

If you need to feed pre-built drafts (the alexandria-spawn pattern, because `draft_from_intake` doesn't iterate over `SeedField::AlexandriaSpawn`), call `pipeline::render_and_publish` directly with your `Vec<CarouselDraft>`.

---

## 6. Next session pickup — Phase 3

Phase 2 is shipped. Phase 3 is small. The pipeline + trigger surface are done; what's left is polish and external integrations.

### 6.1 FIRST — Activate Socket Mode (5-minute human task, not coding)

Code is shipped. The only thing missing is the `xapp-…` token. Steps:

1. **Slack app config** (https://api.slack.com/apps → eric-claude app):
   - Toggle **Socket Mode** → On
   - **OAuth & Permissions** → add scope `connections:write` (already documented in §7.5 of the Phase 1 handoff)
   - **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**
     - Name: `socket-mode`
     - Scope: `connections:write`
     - Copy the `xapp-1-...` token
   - **Slash Commands** → confirm `/carousel-build` exists; Request URL field becomes irrelevant in Socket Mode (Slack uses the WebSocket instead)

2. **Add to 1P** (Rising Tides Production vault, or extend existing "Slack eric-claude bot" item with a new field).

3. **Pipe into the env file:**

```bash
( umask 077 && \
  printf 'SLACK_APP_TOKEN=' >> ~/.cortextos/default/eric-claude-bot.env && \
  op read 'op://Rising Tides Production/<ITEM_ID>/<FIELD_NAME>' >> ~/.cortextos/default/eric-claude-bot.env && \
  printf '\n' >> ~/.cortextos/default/eric-claude-bot.env )
launchctl kickstart -k gui/$(id -u)/com.risingtides.rt-carousel-agent
```

4. **Verify activation:**

```bash
curl -sS http://127.0.0.1:7677/health | python3 -c "import json,sys; d=json.load(sys.stdin); print('socket_mode_enabled:', d['socket_mode_enabled'])"
# Expect: socket_mode_enabled: True

tail -5 /tmp/rt-carousel-agent.err | grep -E "socket-mode|Socket Mode"
# Expect: "starting Slack Socket Mode listener" → "socket-mode WebSocket URL acquired" → "socket-mode connected" → "socket-mode hello"
```

5. **Real test:** type `/carousel-build pre-release curiosity` directly in `#carousels`. Within 22s a draft should appear with 4 PNGs.

If Socket Mode fails to connect: tail `/tmp/rt-carousel-agent.err` for `socket-mode session failed`. Common: token typo, scope missing, Socket Mode toggle off in app config. The agent auto-reconnects with exponential backoff (1s→2s→4s→…→60s cap) so transient failures heal themselves.

### 6.2 After Socket Mode activates — Phase 3 backlog (in priority order)

- **#20 MCP server interface** — expose the agent as MCP tools. Lets other MCP clients (Claude Desktop, etc.) trigger carousels. Implement as a separate binary in the same workspace that talks to the running agent over HTTP. Lower priority than Socket Mode — only Eric uses Claude Code today.
- **Wire `/alexandria-spawn` into `alexandria-slack-notifier.py`** — when an Alexandria entry is published to the team-knowledge repo, optionally fire `POST /alexandria-spawn {note_path: ...}` to auto-generate a carousel draft. Toggle via frontmatter (`auto_carousel: true`).
- **#15 PDF bundler** — `printpdf` already in deps. Wrap the per-slide PNGs into a single PDF (one slide per page). Useful for client deliverables. ~30 min implementation.
- **#24 (new) — Slack reply parser** — when Eric replies in the carousel thread with `:ship_it:`, post the locked draft to IG/Buffer/Postiz. When he replies with edit notes, regenerate just the affected slide. This is the "approve in Slack, ship to IG" loop.
- **#25 (new) — Failed-draft retry surface** — when generation hits a banned phrase or fails source-grounding, currently the draft is dropped silently. Add a Slack message that explains *why* a draft was skipped, so Eric can manually adjust the prompt.

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
| **Slack Socket Mode token** | **`SLACK_APP_TOKEN`** | **TO BE CREATED** (Rising Tides Production, extend `eric-claude bot` item) | **same env file** |

To refresh: pipe `op read 'op://VAULT/ITEM/credential'` directly into the env file. Never let the value enter the chat context.

### 7.2 Reproducing `/tmp/test-slash.sh`

If `/tmp/test-slash.sh` is missing, regenerate (unchanged from Phase 1):

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

- `agent/src/main.rs` — routes, alexandria-spawn handler, AlexandriaNote parser
- `agent/src/pipeline.rs` — **shared orchestration** (NEW — touch this to change any surface)
- `agent/src/socket_mode.rs` — outbound WebSocket listener (NEW)
- `agent/src/slack.rs` — upload + signature verify + slash parsing (richest module)
- `agent/src/render.rs` — Midnight Press HTML + headless Chrome PNG
- `agent/src/pocket.rs` — idempotent panel/card upsert + version bump
- `agent/src/generator.rs` — Claude API prompt construction (voice calibration)
- `agent/src/config.rs` — env loading (now includes `SLACK_APP_TOKEN`, `RT_OBSIDIAN_VAULT`)
- `course-index.md` — §3 claims registry (verification floor)
- `agent/deploy.sh` — rebuild + ad-hoc sign + launchd kickstart
- `~/.claude/skills/rt-carousel-build/SKILL.md` — natural-phrase trigger (outside repo)

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

### 7.5 Slack app scopes

Current `eric-claude` bot has: `chat:write, chat:write.customize, im:write, channels:read, channels:history, groups:read, groups:history, im:read, im:history, users:read, app_mentions:read, mpim:history, files:write`.

**For Socket Mode (Phase 2):** add `connections:write` scope, toggle Socket Mode = On, generate `xapp-…` token. See §6.1 step 1.

---

## 8. Things NOT to revisit (already settled)

- **Vol 02-07 carousel drafts** — parked. Don't regenerate via the agent unless Eric asks.
- **`course-index.md`** — locked. New claims go in §3 (verification floor). Don't restructure.
- **Brand voice rules** — encoded in `course-index.md` §6 + `agent/src/generator.rs` prompts. Don't override per-draft.
- **The 1P → env file pipe pattern** — works, is the chosen path.
- **The launchd plist** — points to `~/bin/`, not `target/`. Don't "fix" this back.
- **The Phase 2 pipeline refactor** — every trigger surface MUST call `pipeline::run_from_intake` or `pipeline::render_and_publish`. Don't inline the draft → render → PNG → Slack → Pocket chain anywhere new.
- **Socket Mode reconnect backoff** — 1s → 60s cap is fine for production. Don't add jitter or change the curve without a measured reason.
- **AlexandriaNote frontmatter parser** — deliberately lightweight (no `serde_yaml` dep). Only parses `title`, `summary`/`description`, `embargo`. If you need more fields, add them — don't pull in a heavy YAML crate.

---

## 9. Acknowledgments

What Phase 2 proved: the trigger surface stack now matches the Layer 4 (Visual/Command) pattern of the Rising Tides Agentic OS. Eric can fire a carousel from:

1. **Slack** — `/carousel-build <topic>` (Socket Mode once token lands)
2. **HTTP** — any script POSTing JSON to `:7677/intake`
3. **Alexandria webhook** — `alexandria-slack-notifier.py` calling `/alexandria-spawn`
4. **Natural language** — "make a carousel about X" inside any Claude Code session

All four paths land at the same `pipeline::run_from_intake` and produce the same brand-perfect output. The source-grounding floor (`course-index.md` §3) is enforced once, in one place, regardless of how the request entered the system.

The single remaining blocker for full automation is human-side: generate the `xapp-…` token and drop it in 1P. Five minutes of work. After that, Eric types `/carousel-build` in Slack and the agent does the rest, forever.

**End of handoff. Pick up at §6.1 (Activate Socket Mode token) in the next session.**

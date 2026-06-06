# rt-carousel-agent

Rising Tides Instagram carousel generation agent. Rust HTTP service that takes a Weekly Content Brief intake (5 answers) and emits Midnight Press carousels — HTML previews, 1080×1350 PNGs, PDFs — posted back into the brief thread on Slack.

**Status:** Scaffold (Phase 1, task #9 — bootstrap only). All module stubs return `not yet implemented` errors. Live pipeline lands in tasks #10–#23 (see project task list).

## Architecture

See parent `../HANDOFF.md` and `../course-index.md`.

```
                      ┌──────────────────────────────┐
   /carousel-build ──►│   rt-carousel-agent (Rust)   │
   MCP tool        ──►│   127.0.0.1:7677              │
   Slack /build    ──►│   launchd service             │
                      └──────────────────────────────┘
                                    │
                                    ▼
                      parse → source-check → generate
                       → render → screenshot → upload
```

## Run

```bash
# Dev
cd agent
cargo run --release

# Hit health
curl http://127.0.0.1:7677/health | jq

# Submit intake
curl -X POST http://127.0.0.1:7677/intake \
  -H 'Content-Type: application/json' \
  -d '{
    "win": "Mon Rovia crossed 1.8M monthly listeners",
    "take": "Drop day isn'\''t launch, it'\''s the finale",
    "course_tease": "Module 3 — popularity score ladder",
    "thread_ts": "1779768103.260319"
  }' | jq
```

## Env

See [`.env.example`](.env.example). `ANTHROPIC_API_KEY` is required once the generator goes live.

## Module layout

| File | Status | Task |
|---|---|---|
| `src/main.rs` | live (skeleton) | #10 |
| `src/types.rs` | live | #10 |
| `src/config.rs` | live | #9 |
| `src/sources.rs` | stub | #11 |
| `src/generator.rs` | stub | #12 |
| `src/render.rs` | stub | #13, #14, #15 |
| `src/slack.rs` | stub | #16, #23 |
| `src/claude_api.rs` | stub | #12 |
| `src/pocket.rs` | stub | #17 |

## Design notes

- **Source verification is the spine.** No carousel ships unless every numeric/factual claim traces to `course-index.md §3`, a real Alexandria entry, or an explicit Slack drop. The `sources` module enforces this.
- **Hybrid generation.** Eric's exact words ship verbatim where given. Claude API fills only the gaps. See `generator.rs`.
- **Output is multi-channel.** HTML preview (repo) + inlined RT Pocket panel + PNG screenshots + PDF + Slack thread post. Each carousel produces all artifacts in one pipeline pass.

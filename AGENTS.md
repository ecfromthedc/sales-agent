# AGENTS.md — RT Agents Monorepo (sales / outreach / carousels)

This repo is the **RT Agents monorepo** — three build lanes sharing a core:

- **sales** (`src/`) — Cloudflare Worker `rt-sales-call-agent`. Closes the lag between a
  Calendly strategy call and the pitch (target < 15 min end-to-end).
- **outreach / Henry** (`./outreach/`) — self-contained CF Worker `rt-henry`.
- **carousels** (`./carousels/agent/`) — Rust axum local daemon.

> **Canonical instructions live in these in-repo docs — read them first:**
> - `ARCHITECTURE.md` — full structure, shared core, CI gates, per-lane build/deploy.
> - `CLAUDE.md` — sales-lane-specific guidance (work under `src/`).
> - Behavior source of truth: `~/Documents/Obsidian Vault/Rising Tides OS/Reference/Sales-Call-Agent-Spec.md`

Owner: Rising Tides — Eric Cromartie (`ec@risingtidesent.com`). Confirm which lane a change
belongs to before editing; respect each lane's deploy target (Workers vs Rust daemon).

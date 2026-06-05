# Sales Agent — Autonomous Build + Auto-Merge Loop

Drives the **SALE-84 epic** to completion: pulls Todo tickets → headless Claude implements
each in an isolated worktree → opens a PR → review agent auto-merges on **green CI**.

## Components
- `sale_loop.py build` — next Todo task in the epic → worktree+branch → `claude -p` implements → PR → ticket **In Review**. (Prioritizes the CI bootstrap SALE-89 first.)
- `sale_loop.py review` — open PRs → require **green required CI checks** → Claude review → auto-merge (squash) → ticket **Done**.
- `run-loop.sh` — cron entrypoint; **paused unless `scripts/loop/ACTIVE` exists**.
- `com.risingtides.sale-loop.plist` — launchd, hourly. Installed + loaded, **no-ops while paused**.

## Safety gates (built in)
1. **No CI → no merge.** `review` refuses to merge any PR without ≥1 passing required check. So "fully auto-merge on green" can't merge anything until CI exists.
2. **SALE-89 (CI bootstrap) is human-merged** — excluded from auto-merge; it's the one PR you eyeball.
3. **Merge ≠ deploy.** Merging to `main` does not ship the production Worker (deploy stays manual).
4. `DRY_RUN=1` logs every action without mutating Linear/GitHub.

## Activation sequence (do this in order)
```bash
cd /Users/ericcromartie/Documents/Development/sales-agent

# 1. Dry-run to watch the plumbing (no changes)
DRY_RUN=1 python3 scripts/loop/sale_loop.py build

# 2. SUPERVISED bootstrap: build the CI PR (SALE-89), review it yourself, merge it.
python3 scripts/loop/sale_loop.py build        # opens the SALE-89 CI/test PR
gh pr list -R ecfromthedc/sales-agent          # review + merge SALE-89 manually

# 3. Once CI exists & green-gates PRs, activate the unattended loop:
touch scripts/loop/ACTIVE                       # cron now builds + auto-merges on green
tail -f logs/loop.log                           # watch it work

# Pause anytime:
rm scripts/loop/ACTIVE
```

## Why supervised-first
Letting headless Claude write code + auto-merge to a live, client-facing production repo
unattended on its very first run is reckless. The CI bootstrap (SALE-89) establishes the
green gate that makes every subsequent auto-merge meaningful. After it lands and you've seen
one clean loop cycle, flip `ACTIVE` and it runs hourly on its own.

Logs: `logs/loop.log`, `logs/launchd.{out,err}`. Unload cron: `launchctl unload ~/Library/LaunchAgents/com.risingtides.sale-loop.plist`.

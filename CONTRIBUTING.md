# Contributing — RT Sales Call Agent

This repo is built and maintained through an autonomous ticket → PR loop driven by
Linear. These conventions are what make that loop work — follow them exactly.

## Branch naming

One branch per Linear ticket, named:

```
sale-<n>-<slug>
```

- `<n>` — the Linear issue number (e.g. `90`).
- `<slug>` — short, lowercase, hyphenated description (e.g. `repo-automation`).

Example: `sale-90-repo-automation`.

Always branch off the latest `origin/main`.

## Pull requests

- **Reference the ticket.** Every PR body MUST contain its `SALE-<n>` id (e.g. `SALE-90`)
  so Linear auto-links the PR to the issue and tracks state. The
  [PR template](.github/PULL_REQUEST_TEMPLATE.md) has a `Linear: SALE-___` line for this —
  fill it in.
- **One ticket per PR.** Keep each PR scoped to a single ticket. Split unrelated work into
  separate branches and PRs.
- **Merge on green CI.** PRs merge to `main` only when required CI checks pass. A PR with no
  passing required check does not merge.

## Local quality gate

Before opening a PR, both of these must pass locally:

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

CI runs the same gate. Don't push red.

Other useful commands:

```bash
npm install
npm run dev         # wrangler dev (local Worker)
npm run deploy      # wrangler deploy (manual — merging to main does NOT auto-deploy)
```

> Note: merging to `main` does not ship the production Worker. Deploys stay manual.

## The autonomous loop

This repo drives tickets to completion with a worktree-based loop under
[`scripts/loop/`](scripts/loop/) (see `scripts/loop/README.md` for the full activation
sequence and safety gates). In short:

1. The loop pulls the next Todo ticket from the Linear epic.
2. Headless Claude implements it in an **isolated git worktree** on a `sale-<n>-<slug>`
   branch — keeping each ticket's work isolated from the others.
3. It opens a PR whose body references the `SALE-<n>` id.
4. A review pass auto-merges (squash) on **green required CI**, then moves the ticket to
   Done.

Built-in safety gates: no merge without a passing required CI check, the CI-bootstrap PR is
human-merged, merge ≠ deploy, and `DRY_RUN=1` logs every action without mutating Linear or
GitHub. The loop is **paused unless `scripts/loop/ACTIVE` exists**.

When you contribute by hand, mirror what the loop does: one ticket, one `sale-<n>-<slug>`
branch, a PR that references `SALE-<n>`, and a green local gate before you push.

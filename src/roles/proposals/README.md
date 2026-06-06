# Proposals role — thin pointer (NOT a pipeline)

**There is no separate proposals pipeline.** The canonical proposals surface IS the
existing **sales** proposal pipeline. This directory is intentionally thin: a README
that points at the production code. Do **not** duplicate, fork, or re-implement the
pipeline here — extend the sales role instead.

## Where the real code lives

| Concern | File |
|---------|------|
| Proposal drafter (Claude compose + orchestration) | [`src/roles/sales/agents/proposal-drafter.ts`](../sales/agents/proposal-drafter.ts) |
| House-style HTML renderer ("Midnight Press") | [`src/roles/sales/integrations/proposal-render.ts`](../sales/integrations/proposal-render.ts) |
| Public client-facing viewer (`GET /p/:dealId`) | [`src/roles/sales/triggers/proposal-public.ts`](../sales/triggers/proposal-public.ts) |
| Fireflies transcript webhook (entry point) | [`src/roles/sales/triggers/fireflies-webhook.ts`](../sales/triggers/fireflies-webhook.ts) |
| Slack refine loop — Events API | [`src/roles/sales/triggers/slack-events.ts`](../sales/triggers/slack-events.ts) |
| Slack refine loop — interactions | [`src/roles/sales/triggers/slack-interactions.ts`](../sales/triggers/slack-interactions.ts) |

## The flow

```
Fireflies transcript (fireflies-webhook.ts)
  → composeProposal (Claude, via lib/anthropic)
  → renderProposalHtml — house-style "Midnight Press" HTML (proposal-render.ts)
  → host on R2 under proposals/<dealId>/latest.html (PITCH_PDFS bucket)
  → serve as a live link at GET /p/:dealId (proposal-public.ts)
  → post the link to Slack #proposals for review
  → refine by replying in-thread → re-compose → re-render → re-host (slack-events.ts)
```

A meeting transcript lands via the Fireflies webhook, `composeProposal` (Claude)
turns it into structured proposal content, `renderProposalHtml` renders the locked
Rising Tides house-style HTML, the result is hosted on R2 and served at a stable
public URL, and the link is posted to Slack `#proposals`. Eric refines simply by
replying in the Slack thread — each reply re-runs the compose → render → host steps
and updates the same live link.

## External setup required

This pipeline depends on two external integrations that must be configured outside
the code. See **[`PROPOSAL_PIPELINE_SETUP.md`](../../../PROPOSAL_PIPELINE_SETUP.md)**
at the repo root for the full walkthrough.

- **Fireflies webhook** — point Fireflies at the worker's Fireflies webhook URL and
  set `FIREFLIES_WEBHOOK_SECRET` (the webhook handler verifies every payload against it).
- **Slack Events API** — subscribe the Slack app to message events (so in-thread
  refine replies reach the worker) and set `SLACK_SIGNING_SECRET` (every Slack request
  is signature-verified against it).

## Future enhancement

Salvage the **destructive-patch guard** idea from `patch-guard.mjs` (the
proposals-agent R&D lab) and apply it to the HTML refine loop — a guard that rejects
a refine instruction whose resulting patch would blow away large swaths of the
existing proposal HTML, so a single bad refine reply can't nuke a good proposal.

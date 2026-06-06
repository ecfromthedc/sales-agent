# Email role — charter

The **EMAIL** role is the last role in the monorepo. It is a CREATE that consolidates
two scattered predecessors into one home:

- the **chief-of-staff triage spec** (the "what counts as actionable mail" rules), and
- the loose **`email-*.py` scripts** that previously did ad-hoc Gmail sweeps.

Future tickets wire the actual Gmail surface (read, label, draft, unsubscribe). **This
slice is the pure decision core only** — no Gmail, no network, no sending.

## What this role does (once fully wired)

1. **4-tier Gmail triage.** Every inbound message is classified into exactly one tier:

   | Tier | Meaning | Downstream action |
   |------|---------|-------------------|
   | `skip` | Pure noise — automated `noreply`/notification senders, bulk/list mail | Archive / no surfacing |
   | `info_only` | FYI mail — newsletters, digests, receipts, automated alerts | Keep, surface as low-priority digest |
   | `meeting_info` | Scheduling signal — calendar invites, Calendly, "are you free?" | Surface for calendar action |
   | `action_required` | Needs a human reply — direct questions, personal asks, in-thread replies addressed to the user | Surface + draft a reply |

2. **Draft replies behind a HUMAN approval gate.** For `action_required` mail the role
   may compose a draft reply, but it **NEVER auto-sends**. Eric reviews and sends. This
   mirrors the rest of the monorepo's "draft-only, human-in-the-loop" doctrine.

3. **Unsubscribe.** For recurring `skip`/`info_only` senders the role can surface an
   unsubscribe action (using `List-Unsubscribe` headers) — also human-gated.

## What's in this directory now

| File | Purpose |
|------|---------|
| [`triage.ts`](./triage.ts) | **Pure, deterministic** 4-tier classifier — `classifyEmail()`. No I/O, no network, Workers-compatible. The decision core every future Gmail wiring will call. |

## Boundaries (this ticket — SALE-117)

- **No Gmail wiring.** No reading, labeling, drafting, or unsubscribing against a real
  inbox yet.
- **No Worker entry/route.** No cron, no HTTP handler. Later tickets add those.
- **No sending, ever.** Auto-send is explicitly out of scope for the role entirely —
  the approval gate is a permanent design constraint, not a phase.

## The classifier — `classifyEmail`

```ts
classifyEmail(input: {
  from: string;
  subject: string;
  snippet: string;
  headers?: Record<string, string>;
}): {
  tier: "skip" | "info_only" | "meeting_info" | "action_required";
  reasons: string[]; // ALL matched rules, for transparency/debugging
  score?: number;    // internal action-likelihood signal
}
```

It is **deterministic**: same input always yields the same output. It performs no I/O
and touches no network, so it is trivially unit-testable and safe to run anywhere
(including a Cloudflare Worker). The tier is chosen by a precedence ladder — automated
noise is demoted first, then scheduling signals and actionable asks are promoted — and
**every matched rule is returned in `reasons[]`** so a human (or a future audit log) can
see exactly why a message landed where it did.

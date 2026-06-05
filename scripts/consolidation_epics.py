#!/usr/bin/env python3
"""Create the RT Agents Monorepo Consolidation project + role epics in Linear SALE team."""
import json, urllib.request

KEY = open("/tmp/linear_key.txt").read().strip()
TEAM = "b5914e6a-39c5-479d-a443-951fa9d8a5c3"
STATE_TODO = "3d3088b0-a9ea-40cf-9f47-61a84255df7a"
L_FEATURE = "4f000ce2-57d4-4434-92c0-b74b858204c9"
L_IMPROVE = "a1f70c5e-c989-4eb4-a2b3-ab76f1e10233"


def gql(q, v):
    req = urllib.request.Request("https://api.linear.app/graphql",
        data=json.dumps({"query": q, "variables": v}).encode(),
        headers={"Authorization": KEY, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if "errors" in d:
        raise RuntimeError(json.dumps(d["errors"])[:300])
    return d["data"]


def issue(title, desc, project, parent=None, label=L_FEATURE):
    inp = {"teamId": TEAM, "title": title, "description": desc, "stateId": STATE_TODO,
           "projectId": project, "labelIds": [label]}
    if parent:
        inp["parentId"] = parent
    return gql("mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier url}}}",
               {"i": inp})["issueCreate"]["issue"]


proj = gql("mutation($i:ProjectCreateInput!){projectCreate(input:$i){project{id url}}}",
    {"i": {"name": "RT Agents · Monorepo Consolidation", "teamIds": [TEAM],
           "targetDate": "2026-07-15",
           "description": "Fold RT agent buildouts into the sales-agent repo as ROLES (sales, outreach, email, proposals) + a carousels local lane, driven by the Linear->PR->auto-merge pipeline. See MONOREPO-CONSOLIDATION-PLAN.md."}})["projectCreate"]["project"]
pid = proj["id"]
print("PROJECT:", proj["url"])

EPICS = [
 ("EPIC: P0 — Data safety (back up all agent code)",
  "Nothing else until every line is in version control.\n\n- [x] git-init + commit Henry/outreach-agent (done — bcb9706); pg_dump henry_gap (done)\n- [ ] Commit sales-agent proposal pipeline (8 new src + 14 modified, currently on NO branch)\n- [ ] carousels-agent: add git remote + push; commit voice-upgrade WIP (generator.rs/sources.rs)\n- [ ] html-only-agent: commit + push uncommitted work; salvage patch-guard.mjs idea\n- [ ] .gitignore noise everywhere (scraper/.venv, logs/, exports/, target/, .DS_Store)\n- [ ] Create GitHub remotes (Henry) + decide monorepo vs polyrepo-with-shared-package", L_IMPROVE),
 ("EPIC: shared/ libs + tools/loop pipeline engine",
  "Extract deduped shared libs and generalize the SALE-84 build loop.\n\n- [ ] Extract shared/: notion, anthropic, google-auth, gmail, drive, spotify, music-enrich (chartmetric+songstats), slack (verify+notify), pdf-r2, env-base\n- [ ] Diff Henry vs sales integration files; reconcile (Henry inlines Gmail OAuth; sales has google-auth.ts)\n- [ ] Generalize scripts/loop/ → tools/loop/ parameterized by role+epic+repo (remove hardcoded SALE-84/REPO/node-ids)\n- [ ] Multi-epic dashboard\n- [ ] ci.yml workflow once gh token has `workflow` scope (carryover from SALE-89)", L_IMPROVE),
 ("EPIC: Role — Sales (host repo, in place)",
  "sales-agent becomes roles/sales. Mostly in place.\n\n- [ ] Commit + land the proposal pipeline (proposal-drafter, fireflies-webhook, slack-events, proposal-render, proposal-public, chartmetric) via PRs — completes SALE-86/87 intent on main\n- [ ] Move src/ under roles/sales/ once shared/ exists\n- [ ] External setup: Fireflies webhook + secret, Slack Events API, Browser Rendering binding, Gmail compose scope", L_FEATURE),
 ("EPIC: Role — Outreach (Henry: gap engine + Postgres)",
  "outreach-agent becomes roles/outreach. Already backed up this session.\n\n- [ ] Create GitHub remote + push Henry\n- [ ] Dedupe integrations against shared/ (notion/spotify/gmail/anthropic)\n- [ ] Preserve gap_pipeline (Python) + henry_gap Postgres + out/cache as role-local assets\n- [ ] Merge Henry crons into the unified wrangler (daily scan, weekly gap, 2h inbox-cleaner)\n- [ ] Document the Postgres dependency loudly (lives outside repo)", L_FEATURE),
 ("EPIC: Role — Email (NEW — chief-of-staff + email scripts)",
  "Create a real email role from scattered functionality.\n\n- [ ] Consolidate ~/.claude/agents/chief-of-staff.md triage spec + Projects/active email-*.py (dashboard, sender, unsubscribe) + outreach inbox-cleaner into roles/email\n- [ ] CF Worker: Gmail triage (4-tier), draft replies (approval gate, no auto-send), unsubscribe\n- [ ] Decide scope: triage-only vs triage+send+unsubscribe\n- [ ] Wire to rt-command-center email panels (UI already exists)", L_FEATURE),
 ("EPIC: Role — Proposals (thin over sales pipeline)",
  "Proposals = alias/docs over sales' existing pipeline. Do NOT duplicate.\n\n- [ ] Confirm sales/ proposal pipeline is the single source of truth\n- [ ] Thin roles/proposals pointer + docs\n- [ ] Salvage proposals-agent: commit html-only-agent WIP, lift patch-guard.mjs into the refine loop, then archive proposals-agent\n- [ ] Preserve findings/task_plan/progress design rationale to Obsidian", L_IMPROVE),
 ("EPIC: Carousels — local-daemon lane (not a Worker role)",
  "Rust axum daemon — incompatible with Workers (headless-Chrome, osascript iMessage, launchd). Consolidate repo+remote+docs only; runtime stays local.\n\n- [ ] Add git remote + push carousels-agent; commit voice-upgrade WIP\n- [ ] Bring in as top-level carousels/ Rust crate (separate deploy lane)\n- [ ] Share only Anthropic/Slack conventions + Alexandria grounding at monorepo root\n- [ ] Fix the open Slack :ship_it: event-delivery bug (HANDOFF-PHASE3 Path A/B)\n- [ ] (Optional, big) evaluate Workers rewrite w/ externalized rendering — likely NOT worth it", L_IMPROVE),
]

epics = []
for title, desc, lab in EPICS:
    it = issue(title, desc, pid, label=lab)
    epics.append(it)
    print(f"  {it['identifier']}  {title}")

# P0 actionable sub-issues under the P0 epic (the immediate, pipeline-drivable tasks)
p0 = epics[0]["id"]
P0_TASKS = [
 ("consolidation: Commit sales-agent proposal pipeline to main (via PRs)",
  "The proposal pipeline (proposal-drafter.ts, fireflies-webhook.ts, slack-events.ts, proposal-render.ts, proposal-public.ts, chartmetric.ts + 14 modified files) is uncommitted on NO branch — highest data-loss risk. Commit in atomic PRs through the pipeline. Completes SALE-86/87 intent on main."),
 ("consolidation: carousels-agent — add remote + push + commit voice WIP",
  "carousels-agent has NO git remote (unbacked) and uncommitted code (generator.rs Eric-voice fingerprint, sources.rs §6.4 voice_rules) + 13 draft previews. Add .gitignore (exports/, target/, .env, .DS_Store), commit WIP, create remote, push."),
 ("consolidation: html-only-agent — commit/push WIP; salvage patch-guard.mjs",
  "html-only-agent (git, remote exists) has 9 modified + untracked proposal-context/, session-logs.ts unpushed. Commit + push. Salvage mesh-lab patch-guard.mjs (destructive-patch guard) for the refine loop. Then archive proposals-agent."),
 ("consolidation: .gitignore noise sweep across all agent repos",
  "Ensure scripts/scraper/.venv, logs/, exports/, agent/target/, **/.DS_Store are gitignored everywhere before any monorepo move (the scraper .venv is the bulk of sales-agent's untracked noise)."),
]
for t, d in P0_TASKS:
    it = issue(t, d, pid, parent=p0, label=L_IMPROVE)
    print(f"    └ {it['identifier']}  {t[:50]}")

print("\nDONE. Project:", proj["url"])

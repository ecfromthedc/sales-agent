#!/usr/bin/env python3
"""Create the 'Sales Agent — Production-Complete' epic + tasks + goal in Linear SALE team.
Idempotent-ish: creating re-runs will duplicate, so run once. Prints created identifiers.
"""
import json, os, urllib.request

KEY = open("/tmp/linear_key.txt").read().strip()
TEAM = "b5914e6a-39c5-479d-a443-951fa9d8a5c3"
STATE_TODO = "3d3088b0-a9ea-40cf-9f47-61a84255df7a"
L = {"Feature": "4f000ce2-57d4-4434-92c0-b74b858204c9",
     "Improvement": "a1f70c5e-c989-4eb4-a2b3-ab76f1e10233",
     "Bug": "db04a482-e335-41f2-9ad4-021e1bb331fc"}
REUSE = {  # identifier -> node id (re-parent under the epic, move to Todo)
    "SALE-55": "e6e754a5-d726-4b81-97ad-31450b1dd7f9",
    "SALE-57": "334617ec-845c-4fe9-96c7-6059e16fa062",
    "SALE-59": "26513728-c9db-477a-9c9e-2705bdd6809b",
    "SALE-61": "abdc8ff0-1ff2-4bb5-9b57-f70738b0dd2e",
    "SALE-62": "7ff4b53f-f5f0-4679-87a4-90c2fad5366a",
    "SALE-63": "1f09c62a-816d-4c07-9e3c-508a487895ff",
    "SALE-66": "9ab6e33a-ceef-4ad6-93a5-c748d1a74dc9"}
TARGET_DATE = "2026-06-19"


def gql(query, variables):
    req = urllib.request.Request("https://api.linear.app/graphql",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={"Authorization": KEY, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if "errors" in d:
        raise RuntimeError(json.dumps(d["errors"])[:400])
    return d["data"]


PR = ("\n\n---\n**Execution contract (autonomous loop):**\n"
      "- Branch `sale-<n>-<slug>`; open a PR whose body contains this issue's `SALE-<n>` id (Linear auto-links).\n"
      "- PR must pass CI (typecheck + tests) before the review agent auto-merges on green.\n"
      "- Touch only this task's surface area; no cross-task coupling (epic tasks are independent).")

NEW = [
 ("T1", "sales-agent: Wire CF Browser Rendering → real Swiss-grid PDF to R2", "Feature",
  "Replace the `pdf.ts` placeholder. Wire the Cloudflare Browser Rendering binding, render the Swiss-grid HTML deck to PDF, upload to R2 `rt-sales-pitch-pdfs`, return the real key.\n\n**Acceptance:** post-call pitch produces a downloadable PDF in R2 (no placeholder key); deal record links it; typecheck clean."),
 ("T2", "sales-agent: Proposal pipeline end-to-end (Fireflies → R2 /p/:dealId)", "Feature",
  "Wire `/webhooks/fireflies` → fetch transcript → resolve deal → Claude drafts proposal → render house-style HTML → host on R2 at `/p/:dealId`.\n\n**Acceptance:** a Fireflies event yields a live proposal link; assumptions/missing-data/source-claims written to Notion; integration test covers the happy path."),
 ("T3", "sales-agent: Proposal Slack refine loop (#proposals thread → regen)", "Feature",
  "Eric replies in the #proposals thread → regenerate proposal with the feedback → repost updated link. Slack Events API + signature verification.\n\n**Acceptance:** a thread reply triggers a regenerated, reposted link; no auto-send of client email."),
 ("T11", "sales-agent: Confirm Tides Tracker base URL; crm-lookup = source of truth", "Improvement",
  "Resolve the `TIDES_TRACKER_BASE_URL` TODO and make `crm-lookup` the canonical campaign-data source; deprecate the broken Tides Tracker stub path.\n\n**Acceptance:** enrichment reads from crm-lookup; no dead TODO; graceful fallback when data missing."),
 ("T12", "sales-agent: Test suite (vitest) + GitHub Actions CI gate", "Improvement",
  "**BOOTSTRAP — human-reviewed merge (the auto-merge gate depends on this).** Add vitest, unit tests for agents + integrations (mocked fetch), and a GitHub Actions workflow running `tsc --noEmit` + tests on every PR as a required status check.\n\n**Acceptance:** CI runs on PRs and reports a required check; baseline tests green; `npm test` works locally."),
 ("T13", "sales-agent: Repo automation — branch convention + Linear↔GitHub PR auto-link", "Improvement",
  "Document/enforce `sale-<n>-<slug>` branch naming; ensure the Linear↔GitHub integration links PRs to issues (PR body references `SALE-<n>`); add a PR template.\n\n**Acceptance:** a PR referencing SALE-<n> moves the issue to In Review and links automatically."),
 ("T14", "sales-agent: Health/observability endpoint", "Feature",
  "Add `GET /health` and a lightweight status endpoint (last cron run, last brief/pitch, error counts from KV).\n\n**Acceptance:** `/health` returns service + last-run timestamps; no secrets leaked."),
 ("T15", "sales-agent: Live smoke-test harness (post-call end-to-end)", "Feature",
  "A `POST /test/smoke` (auth-gated) that runs the full post-call path against a fixture transcript and asserts brief→pitch→PDF→Notion all succeed.\n\n**Acceptance:** one call exercises the real pipeline end-to-end and returns a pass/fail report."),
]


def main():
    # 1) Goal = a Project with a target date
    proj = gql("""mutation($i:ProjectCreateInput!){projectCreate(input:$i){project{id url name}}}""",
        {"i": {"name": "Sales Agent · Production-Complete", "teamIds": [TEAM],
               "targetDate": TARGET_DATE,
               "description": "Goal: finish rt-sales-call-agent to production-complete (no stubs, tested, CI-gated) via the autonomous ticket→PR→review→auto-merge loop. Target " + TARGET_DATE + "."}})["projectCreate"]["project"]
    print("GOAL/Project:", proj["name"], proj["url"])
    pid = proj["id"]

    # 2) Epic parent issue
    epic = gql("""mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier url}}}""",
        {"i": {"teamId": TEAM, "title": "EPIC: Sales Agent — Production-Complete",
               "description": "Parent epic. Independent, parallelizable tasks (each = 1 branch → 1 PR, no blockers). Worked autonomously: sub-agents implement tickets → PRs → review agent auto-merges on green CI. **T12 (CI) is the human-reviewed bootstrap; auto-merge applies to the rest once CI exists.**" + PR,
               "stateId": STATE_TODO, "projectId": pid, "labelIds": [L["Feature"]]}})["issueCreate"]["issue"]
    print("EPIC:", epic["identifier"], epic["url"])
    epic_id = epic["id"]

    # 3) New task sub-issues
    created = []
    for code, title, label, desc in NEW:
        it = gql("""mutation($i:IssueCreateInput!){issueCreate(input:$i){issue{id identifier}}}""",
            {"i": {"teamId": TEAM, "title": title, "description": desc + PR,
                   "stateId": STATE_TODO, "projectId": pid, "parentId": epic_id,
                   "labelIds": [L[label]]}})["issueCreate"]["issue"]
        created.append((code, it["identifier"]))
        print(f"  NEW {code}: {it['identifier']}  {title[:50]}")

    # 4) Re-parent existing backlog tickets under the epic + project + Todo
    for ident, nid in REUSE.items():
        gql("""mutation($id:String!,$i:IssueUpdateInput!){issueUpdate(id:$id,input:$i){success}}""",
            {"id": nid, "i": {"parentId": epic_id, "projectId": pid, "stateId": STATE_TODO}})
        print(f"  REUSE {ident}: re-parented under epic, moved to Todo")

    print("\nEPIC COMPLETE. Goal:", proj["url"])
    print("Epic issue:", epic["url"])


if __name__ == "__main__":
    main()

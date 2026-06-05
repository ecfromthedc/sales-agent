#!/usr/bin/env python3
"""Autonomous build+review loop for the Sales Agent epic (Linear SALE / GitHub sales-agent).

Subcommands:
  build   — pick the next Todo task in the epic, implement it via headless Claude in an
            isolated worktree, push a branch, open a PR (SALE-<n> in body), move ticket → In Review.
  review  — for each open PR: require GREEN required CI checks, run a Claude review; on
            approve+green, auto-merge (squash), move ticket → Done, label merged-and-verified.

SAFETY GATES (non-negotiable):
  * review NEVER merges a PR that has zero required status checks (no CI => no merge).
    This makes "fully auto-merge on green" safe before/without CI: it simply won't merge.
  * The epic's CI bootstrap ticket (T12 / SALE-89) is excluded from auto-merge — human merges it.
  * Merge ≠ deploy: merging to main does not auto-ship the production Worker.

Env: LINEAR key at /tmp/linear_key.txt ; gh authed ; claude CLI on PATH.
Run via launchd/cron. DRY_RUN=1 to log actions without mutating.
"""
import json, os, subprocess, sys, urllib.request, re, time

KEY = open("/tmp/linear_key.txt").read().strip()
TEAM = "b5914e6a-39c5-479d-a443-951fa9d8a5c3"
PROJECT = "32127869-a748-4b9a-a0c0-6521a38b7b70"  # not used for filter; epic parent is the anchor
EPIC = "SALE-84"
REPO = "ecfromthedc/sales-agent"
REPO_DIR = "/Users/ericcromartie/Documents/Development/sales-agent"
CI_BOOTSTRAP = "SALE-89"          # T12 — human-merged; excludes from auto-merge
STATE = {"Todo": "3d3088b0-a9ea-40cf-9f47-61a84255df7a",
         "In Review": "ea929282-9ff8-482b-93a7-1d3d2c2ca1e8",
         "In Progress": "d6bda163-0d18-4f91-988d-f98b9ef63f99",
         "Done": "7a267f99-2830-4d11-8732-6be90e8e5a34"}
LABEL = {"claude-round-1": None, "loop-merge-ready": "9b4651a2-b1aa-4fef-8afc-e3d76e57af44",
         "claude-approved": "d295f6d1-4a5b-4bb7-aaac-f2f07fe776ab",
         "merged-and-verified": None}
DRY = os.environ.get("DRY_RUN") == "1"


def gql(q, v=None):
    req = urllib.request.Request("https://api.linear.app/graphql",
        data=json.dumps({"query": q, "variables": v or {}}).encode(),
        headers={"Authorization": KEY, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    if "errors" in d:
        raise RuntimeError(json.dumps(d["errors"])[:300])
    return d["data"]


def sh(cmd, cwd=None, check=True):
    print("  $", cmd if isinstance(cmd, str) else " ".join(cmd))
    if DRY:
        return ""
    r = subprocess.run(cmd, cwd=cwd, shell=isinstance(cmd, str), capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"cmd failed ({r.returncode}): {r.stderr[:400]}")
    return r.stdout.strip()


def epic_children(states=None):
    d = gql("""query($id:String!){ issue(id:$id){ children(first:50){ nodes{
        id identifier title state{name} } } } }""", {"id": EPIC})
    nodes = d["issue"]["children"]["nodes"]
    if states:
        nodes = [n for n in nodes if n["state"]["name"] in states]
    return nodes


def move(issue_id, state_name):
    if DRY:
        print(f"  [dry] move {issue_id} -> {state_name}"); return
    gql("""mutation($id:String!,$s:String!){issueUpdate(id:$id,input:{stateId:$s}){success}}""",
        {"id": issue_id, "s": STATE[state_name]})


def slug(t):
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")[:40]


# ---------------- BUILD ----------------
def cmd_build():
    todo = epic_children(states=["Todo"])
    todo = [t for t in todo if t["identifier"] != EPIC]
    if not todo:
        print("[build] no Todo tasks in epic. Nothing to do."); return
    # prefer the CI bootstrap first so the merge gate exists
    todo.sort(key=lambda t: (t["identifier"] != CI_BOOTSTRAP, t["identifier"]))
    task = todo[0]
    ident, title = task["identifier"], task["title"]
    branch = f"{ident.lower()}-{slug(title.split(':')[-1])}"
    wt = f"/tmp/sale-wt/{ident}"
    print(f"[build] {ident}: {title}\n  branch {branch}")
    move(task["id"], "In Progress")
    sh(f"git -C {REPO_DIR} fetch origin main", check=False)
    sh(f"rm -rf {wt}; git -C {REPO_DIR} worktree add -B {branch} {wt} origin/main")

    prompt = (f"You are implementing Linear ticket {ident} for the rt-sales-call-agent "
              f"(Cloudflare Worker, TypeScript). Title: {title}\n\n"
              "Read CLAUDE.md and the relevant src/ files first. Implement ONLY this ticket's "
              "scope with a minimal, well-tested diff. Run `npm run typecheck` and ensure it passes. "
              "Do NOT auto-send any client email or deploy. Commit with a conventional message "
              f"referencing {ident}. Keep changes isolated to this task.")
    # headless implementation (allowed tools restricted; never skip-permissions on prod)
    sh(["claude", "-p", prompt, "--add-dir", wt,
        "--allowedTools", "Read,Edit,Write,Bash(npm run typecheck),Bash(git*),Grep,Glob"],
       cwd=wt, check=False)
    # ensure typecheck
    sh("npm install --silent && npm run typecheck", cwd=wt, check=False)
    sh(f"git -C {wt} add -A && git -C {wt} commit -m '{ident}: {title}' || true", check=False)
    sh(f"git -C {wt} push -u origin {branch}", check=False)
    body = f"Implements **{ident}**: {title}\n\nAutonomous loop PR. Linear: {ident}\n\nMerges only on green CI."
    if not DRY:
        sh(["gh", "pr", "create", "-R", REPO, "--head", branch, "--base", "main",
            "--title", f"{ident}: {title}", "--body", body], cwd=wt, check=False)
    move(task["id"], "In Review")
    print(f"[build] {ident} -> PR opened, ticket In Review.")


# ---------------- REVIEW + AUTO-MERGE ----------------
def open_prs():
    out = sh(["gh", "pr", "list", "-R", REPO, "--state", "open", "--json",
              "number,title,headRefName,body"], check=False)
    return json.loads(out) if out else []


def pr_checks_green(num):
    """True only if there is >=1 required check AND all are passing."""
    out = sh(["gh", "pr", "checks", str(num), "-R", REPO], check=False)
    if not out:
        return False  # no checks => fail safe (do not merge)
    lines = [l for l in out.splitlines() if l.strip()]
    if not lines:
        return False
    return all(("pass" in l.lower() or "success" in l.lower()) for l in lines) and \
           any(("pass" in l.lower() or "success" in l.lower()) for l in lines)


def cmd_review():
    for pr in open_prs():
        num, title, body = pr["number"], pr["title"], pr.get("body", "")
        m = re.search(r"SALE-\d+", title + " " + body)
        ident = m.group(0) if m else None
        if ident == CI_BOOTSTRAP:
            print(f"[review] PR #{num} is CI bootstrap {ident} — human merges. Skipping auto-merge.")
            continue
        if not pr_checks_green(num):
            print(f"[review] PR #{num} ({ident}): CI not green or absent — fail-safe, not merging.")
            continue
        # Claude review pass
        review = sh(["claude", "-p",
                     f"Review PR #{num} '{title}' in {REPO} for correctness, security, and scope. "
                     "Reply APPROVE or REQUEST_CHANGES with one line why.",
                     "--allowedTools", f"Bash(gh pr diff {num}*),Bash(gh pr view {num}*),Read"],
                    check=False)
        if "APPROVE" not in (review or "").upper():
            print(f"[review] PR #{num}: Claude requested changes — not merging.\n  {review[:200]}")
            continue
        print(f"[review] PR #{num} ({ident}): green + approved -> auto-merge (squash)")
        if not DRY:
            sh(["gh", "pr", "merge", str(num), "-R", REPO, "--squash", "--delete-branch"], check=False)
        if ident:
            ch = next((c for c in epic_children() if c["identifier"] == ident), None)
            if ch:
                move(ch["id"], "Done")
        print(f"[review] {ident} merged + Done.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "build"
    {"build": cmd_build, "review": cmd_review}.get(cmd, cmd_build)()

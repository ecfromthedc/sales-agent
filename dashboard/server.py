#!/usr/bin/env python3
"""Live pipeline dashboard backend.

Serves index.html and /api/state — a real-time merge of Linear (epic ticket states)
and GitHub (PRs + CI check status) for the SALE-84 epic. Secrets stay server-side.
Run: python3 dashboard/server.py  ->  http://localhost:8787
"""
import json, os, subprocess, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = open("/tmp/linear_key.txt").read().strip()
EPIC = "SALE-84"
REPO = "ecfromthedc/sales-agent"
HERE = os.path.dirname(os.path.abspath(__file__))
COLUMNS = ["Todo", "In Progress", "In Review", "Done"]
_cache = {"t": 0, "data": None}
CACHE_TTL = 6


def linear(q, v=None):
    req = urllib.request.Request("https://api.linear.app/graphql",
        data=json.dumps({"query": q, "variables": v or {}}).encode(),
        headers={"Authorization": KEY, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())["data"]


def gh_json(args):
    try:
        out = subprocess.run(["gh"] + args, capture_output=True, text=True, timeout=25)
        return json.loads(out.stdout) if out.stdout.strip() else []
    except Exception:
        return []


def checks_of(pr):
    roll = pr.get("statusCheckRollup") or []
    if not roll:
        return "none"
    states = []
    for c in roll:
        s = (c.get("conclusion") or c.get("status") or c.get("state") or "").upper()
        states.append(s)
    if any(s in ("FAILURE", "ERROR", "CANCELLED", "TIMED_OUT") for s in states):
        return "failing"
    if any(s in ("IN_PROGRESS", "QUEUED", "PENDING", "WAITING", "") for s in states):
        return "pending"
    if all(s in ("SUCCESS", "COMPLETED", "NEUTRAL", "SKIPPED") for s in states):
        return "passing"
    return "pending"


def build_state():
    if time.time() - _cache["t"] < CACHE_TTL and _cache["data"]:
        return _cache["data"]
    d = linear("""query($id:String!){ issue(id:$id){ identifier title
        project{targetDate} children(first:50){ nodes{
        identifier title updatedAt state{name} labels{nodes{name}} } } } }""", {"id": EPIC})
    epic = d["issue"]
    prs = gh_json(["pr", "list", "-R", REPO, "--state", "all", "--limit", "50", "--json",
                   "number,title,body,state,url,mergedAt,statusCheckRollup,headRefName"])
    pr_by_ident = {}
    import re
    for p in prs:
        m = re.search(r"SALE-\d+", (p.get("title") or "") + " " + (p.get("body") or "") + " " + (p.get("headRefName") or "").upper().replace("-", "-"))
        # also match headRefName like sale-89-...
        if not m:
            m2 = re.search(r"sale-(\d+)", p.get("headRefName") or "")
            if m2:
                ident = "SALE-" + m2.group(1)
            else:
                continue
        else:
            ident = m.group(0)
        prev = pr_by_ident.get(ident)
        if not prev or p["number"] > prev["number"]:
            pr_by_ident[ident] = p

    tickets = []
    for n in epic["children"]["nodes"]:
        ident = n["identifier"]
        pr = pr_by_ident.get(ident)
        prinfo = None
        if pr:
            prinfo = {"number": pr["number"], "url": pr["url"],
                      "merged": bool(pr.get("mergedAt")),
                      "state": pr["state"].lower(),
                      "checks": checks_of(pr)}
        tickets.append({"id": ident, "title": n["title"].replace("sales-agent: ", ""),
                        "state": n["state"]["name"], "updatedAt": n["updatedAt"],
                        "labels": [l["name"] for l in n["labels"]["nodes"]], "pr": prinfo})
    stats = {c: sum(1 for t in tickets if t["state"] == c) for c in COLUMNS}
    data = {"epic": {"id": epic["identifier"], "title": epic["title"],
                     "goal_target": (epic.get("project") or {}).get("targetDate")},
            "columns": COLUMNS, "tickets": tickets, "stats": stats,
            "server_time": time.strftime("%Y-%m-%dT%H:%M:%S")}
    _cache.update(t=time.time(), data=data)
    return data


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.startswith("/api/state"):
            try:
                body = json.dumps(build_state()).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
            self.end_headers(); self.wfile.write(body); return
        path = "/index.html" if self.path in ("/", "") else self.path
        fp = os.path.join(HERE, path.lstrip("/"))
        if os.path.isfile(fp):
            self.send_response(200)
            self.send_header("Content-Type", "text/html" if fp.endswith(".html") else "text/plain")
            self.end_headers(); self.wfile.write(open(fp, "rb").read())
        else:
            self.send_response(404); self.end_headers()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    print(f"Pipeline dashboard live → http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

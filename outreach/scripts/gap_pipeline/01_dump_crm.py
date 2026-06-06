#!/usr/bin/env python3
"""Dump the full Rising Tides CRM from Notion -> crm_rows.json.

Classifies rows into clients (active campaigns) vs leads, and extracts the set
of labels/distro partners we already touch. This is the ground truth for the
gap analysis: anything in our orbit is NOT a gap; the gap is the peer space
around our active CLIENT artists that we don't yet service.
"""
import json
import os
import sys
import time
import urllib.request

CRM_DB_ID = "1961465bb82980c9a1b5c4cb3284149a"
TOKEN = open(os.path.join(os.path.dirname(__file__), "../../.secrets/notion_token")).read().strip()
OUT = os.path.join(os.path.dirname(__file__), "out")
os.makedirs(OUT, exist_ok=True)

# Campaign stages / pipeline statuses that mean "we are actively working / have worked them"
CLIENT_PIPELINE = {"Client"}
ACTIVE_STAGES = {"Signed", "Onboard", "Started Reachout", "Posts are live",
                 "Posts are finished", "Campaign report", "Done"}


def prop_text(p, name):
    v = p.get(name, {})
    if not v:
        return ""
    t = v.get("type")
    if t == "title":
        return "".join(x["plain_text"] for x in v["title"])
    if t == "rich_text":
        return "".join(x["plain_text"] for x in v["rich_text"])
    if t == "select":
        return v["select"]["name"] if v["select"] else ""
    if t == "status":
        return v["status"]["name"] if v["status"] else ""
    if t == "email":
        return v.get("email") or ""
    if t == "number":
        return v.get("number")
    if t == "url":
        return v.get("url") or ""
    if t == "date":
        return (v["date"] or {}).get("start", "") if v.get("date") else ""
    if t == "multi_select":
        return [x["name"] for x in v.get("multi_select", [])]
    return ""


def query_all():
    rows = []
    cursor = None
    while True:
        body = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        req = urllib.request.Request(
            f"https://api.notion.com/v1/databases/{CRM_DB_ID}/query",
            data=json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Notion-Version": "2022-06-28",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.loads(r.read())
        for res in d["results"]:
            p = res["properties"]
            rows.append({
                "artist": prop_text(p, "Artist Name"),
                "song": prop_text(p, "Song Name"),
                "label": prop_text(p, "Label/Distro Partner"),
                "pipeline": prop_text(p, "Pipeline Status"),
                "stage": prop_text(p, "Campaign Stage"),
                "email": prop_text(p, "Key Contact Email"),
                "your_name": prop_text(p, "Your Name"),
                "your_role": prop_text(p, "Your Role"),
                "future_potential": prop_text(p, "Future potencial"),
                "media_spend": prop_text(p, "Media Spend"),
                "booked_revenue": prop_text(p, "Booked Revenue"),
                "desired_start": prop_text(p, "Desired Start Date"),
                "lead_source": prop_text(p, "Lead Source"),
                "created": res.get("created_time", ""),
            })
        if not d.get("has_more"):
            break
        cursor = d["next_cursor"]
        time.sleep(0.2)
    return rows


def main():
    rows = query_all()
    clients = [r for r in rows if r["pipeline"] in CLIENT_PIPELINE or r["stage"] in ACTIVE_STAGES]
    leads = [r for r in rows if r not in clients]

    # Label universe we already touch (normalized lower)
    def norm(s):
        return (s or "").strip()
    worked_labels = sorted({norm(r["label"]) for r in rows if norm(r["label"])},
                           key=str.lower)
    client_labels = sorted({norm(r["label"]) for r in clients if norm(r["label"])},
                           key=str.lower)
    client_artists = sorted({norm(r["artist"]) for r in clients if norm(r["artist"])},
                            key=str.lower)
    all_artists = sorted({norm(r["artist"]) for r in rows if norm(r["artist"])},
                         key=str.lower)

    out = {
        "total_rows": len(rows),
        "n_clients": len(clients),
        "n_leads": len(leads),
        "client_artists": client_artists,
        "all_crm_artists": all_artists,
        "client_labels": client_labels,
        "all_worked_labels": worked_labels,
        "clients": clients,
        "leads": leads,
    }
    with open(os.path.join(OUT, "crm_rows.json"), "w") as f:
        json.dump(out, f, indent=2)

    print(f"Total CRM rows: {len(rows)}")
    print(f"  Clients (active/worked): {len(clients)}")
    print(f"  Leads/other: {len(leads)}")
    print(f"\nClient artists ({len(client_artists)}):")
    for a in client_artists:
        print(f"  - {a}")
    print(f"\nLabels on CLIENT rows ({len(client_labels)}):")
    for l in client_labels:
        print(f"  - {l}")
    print(f"\nAll labels touched anywhere in CRM ({len(worked_labels)}):")
    print("  " + ", ".join(worked_labels))


if __name__ == "__main__":
    main()

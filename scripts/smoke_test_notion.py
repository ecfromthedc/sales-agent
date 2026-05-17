#!/usr/bin/env python3
"""
Smoke test the Notion schema end-to-end:
  1. Create a test Deal
  2. Save a test Transcript linked to it
  3. Attach a test Pitch Artifact
  4. Flip Deal status to "Pitched"
  5. Print URLs so Eric can eyeball it
  6. Optionally clean up (set CLEANUP=1)
"""
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone

NOTION_VERSION = "2022-06-28"
TOKEN = os.environ["NOTION_API_TOKEN"]

DEALS_DB = "3611465b-b829-81de-a237-cf6516fe8fcf"
TRANSCRIPTS_DB = "3611465b-b829-81a0-b6a0-cc55e6ed784c"
PITCHES_DB = "3611465b-b829-8174-875c-c9a6db1540cd"


def api(method, path, body=None):
    url = f"https://api.notion.com/v1{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f"ERROR {method} {path}: {e.code}")
        print(e.read().decode())
        sys.exit(1)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def main():
    # 1) Create test Deal
    deal_starts = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
    deal = api("POST", "/pages", {
        "parent": {"database_id": DEALS_DB},
        "properties": {
            "Name": {"title": [{"text": {"content": "[TEST] Smoke Artist — Strategy Session"}}]},
            "Invitee Email": {"email": "smoke-test@example.com"},
            "Invitee Name": {"rich_text": [{"text": {"content": "Smoke Artist"}}]},
            "Event Starts At": {"date": {"start": deal_starts}},
            "Event URI": {"url": "https://api.calendly.com/scheduled_events/smoke-test-001"},
            "Spotify Link": {"url": "https://open.spotify.com/artist/4q3ewBCX7sLwd24euuV69X"},
            "Status": {"select": {"name": "Briefed"}},
            "Lead Temp": {"select": {"name": "Cold"}},
            "Source": {"select": {"name": "Calendly Strategy Session"}},
        },
    })
    deal_id = deal["id"]
    deal_url = deal["url"]
    print(f"[1] Deal created: {deal_url}")

    # Append pre-call brief content
    api("PATCH", f"/blocks/{deal_id}/children", {
        "children": [
            {"type": "heading_2", "heading_2": {"rich_text": [{"text": {"content": "Pre-Call Brief"}}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Smoke Artist is an indie pop project from Brooklyn. Spotify shows 12,400 monthly listeners with a steep climb after their March single. No prior touchpoint with RT — cold lead."}}]}},
            {"type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Suggested angle: Lean into the post-release momentum. Their audience is converting to followers at an above-average rate, which means a TikTok-led discovery campaign would compound the existing organic lift rather than starting from zero."}}]}},
        ],
    })
    print("[1b] Brief blocks appended")

    # 2) Save transcript linked to the deal
    transcript = api("POST", "/pages", {
        "parent": {"database_id": TRANSCRIPTS_DB},
        "properties": {
            "Name": {"title": [{"text": {"content": "[TEST] Transcript — Smoke Artist"}}]},
            "Deal": {"relation": [{"id": deal_id}]},
            "Started At": {"date": {"start": deal_starts, "end": (datetime.fromisoformat(deal_starts) + timedelta(minutes=15)).isoformat()}},
            "Summary": {"rich_text": [{"text": {"content": "Prospect is releasing an EP in June; budget around $5k; wants UGC-led TikTok push targeting indie pop discovery."}}]},
            "Source": {"select": {"name": "Granola"}},
        },
    })
    print(f"[2] Transcript created: {transcript['url']}")

    # 3) Attach pitch artifact
    pitch = api("POST", "/pages", {
        "parent": {"database_id": PITCHES_DB},
        "properties": {
            "Name": {"title": [{"text": {"content": "[TEST] Pitch — Smoke Artist EP campaign"}}]},
            "Deal": {"relation": [{"id": deal_id}]},
            "PDF Key": {"rich_text": [{"text": {"content": f"pitches/{deal_id}/smoke-test.pdf"}}]},
            "Email Subject": {"rich_text": [{"text": {"content": "Following up on our chat — Smoke Artist EP plan"}}]},
            "Status": {"select": {"name": "Draft"}},
        },
    })
    print(f"[3] Pitch artifact created: {pitch['url']}")

    # 4) Flip deal status
    api("PATCH", f"/pages/{deal_id}", {
        "properties": {"Status": {"select": {"name": "Pitched"}}},
    })
    print("[4] Deal status -> Pitched")

    print("\n=== SMOKE TEST PASSED ===")
    print(f"Open the deal: {deal_url}")
    print("Set CLEANUP=1 and rerun to archive the test records.")

    if os.environ.get("CLEANUP") == "1":
        for pid in (pitch["id"], transcript["id"], deal_id):
            api("PATCH", f"/pages/{pid}", {"archived": True})
        print("[cleanup] all test rows archived")


if __name__ == "__main__":
    main()

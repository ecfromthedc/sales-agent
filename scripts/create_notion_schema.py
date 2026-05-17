#!/usr/bin/env python3
"""
Create the RT Sales Call Agent Notion schema.

Creates:
  1. "Sales Pipeline" page under the RT integration root.
  2. "Deals" database inside that page.
  3. "Transcripts" database inside that page (relation -> Deals).
  4. "Pitch Artifacts" database inside that page (relation -> Deals).

Outputs the three database IDs and patches wrangler.toml.

Idempotent: if a page/db with the same name already exists, reuses it.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

NOTION_VERSION = "2022-06-28"
TOKEN = os.environ.get("NOTION_API_TOKEN")
if not TOKEN:
    sys.exit("NOTION_API_TOKEN env var required")

ROOT_PAGE_ID = "3321465b-b829-80fc-a5a5-d90ca657027d"  # the only page the integration sees
WRANGLER_TOML = Path(__file__).resolve().parent.parent / "wrangler.toml"


def api(method, path, body=None):
    url = f"https://api.notion.com/v1{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
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
        sys.exit(f"Notion API {method} {path} failed: {e.code}\n{e.read().decode()}")


def find_child_page(parent_id, title):
    """Return the page id if a child page with this title exists, else None."""
    res = api("GET", f"/blocks/{parent_id}/children?page_size=100")
    for block in res.get("results", []):
        if block.get("type") == "child_page" and block["child_page"].get("title") == title:
            return block["id"]
    return None


def find_child_database(parent_id, title):
    res = api("GET", f"/blocks/{parent_id}/children?page_size=100")
    for block in res.get("results", []):
        if block.get("type") == "child_database" and block["child_database"].get("title") == title:
            return block["id"]
    return None


def ensure_sales_pipeline_page():
    existing = find_child_page(ROOT_PAGE_ID, "Sales Pipeline")
    if existing:
        print(f"[reuse] Sales Pipeline page: {existing}")
        return existing
    body = {
        "parent": {"page_id": ROOT_PAGE_ID},
        "icon": {"type": "emoji", "emoji": "🌊"},
        "properties": {"title": {"title": [{"text": {"content": "Sales Pipeline"}}]}},
        "children": [
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": {
                    "rich_text": [
                        {
                            "type": "text",
                            "text": {
                                "content": (
                                    "Auto-managed by rt-sales-call-agent. "
                                    "Calendly bookings flow in as Deals; transcripts and "
                                    "pitch artifacts attach automatically."
                                )
                            },
                        }
                    ]
                },
            }
        ],
    }
    page = api("POST", "/pages", body)
    print(f"[create] Sales Pipeline page: {page['id']}")
    return page["id"]


def ensure_deals_db(parent_id):
    existing = find_child_database(parent_id, "Deals")
    if existing:
        print(f"[reuse] Deals db: {existing}")
        return existing
    body = {
        "parent": {"type": "page_id", "page_id": parent_id},
        "title": [{"type": "text", "text": {"content": "Deals"}}],
        "icon": {"type": "emoji", "emoji": "💼"},
        "properties": {
            "Name": {"title": {}},
            "Invitee Email": {"email": {}},
            "Invitee Name": {"rich_text": {}},
            "Event Starts At": {"date": {}},
            "Event URI": {"url": {}},
            "Spotify Link": {"url": {}},
            "Status": {
                "select": {
                    "options": [
                        {"name": "Booked", "color": "blue"},
                        {"name": "Briefed", "color": "purple"},
                        {"name": "Called", "color": "yellow"},
                        {"name": "Pitched", "color": "orange"},
                        {"name": "Won", "color": "green"},
                        {"name": "Lost", "color": "red"},
                    ]
                }
            },
            "Lead Temp": {
                "select": {
                    "options": [
                        {"name": "Cold", "color": "gray"},
                        {"name": "Warm", "color": "yellow"},
                        {"name": "Existing Client", "color": "green"},
                    ]
                }
            },
            "Source": {
                "select": {
                    "options": [
                        {"name": "Calendly Strategy Session", "color": "blue"},
                        {"name": "Inbound", "color": "purple"},
                        {"name": "Outbound", "color": "orange"},
                        {"name": "Referral", "color": "pink"},
                    ]
                }
            },
        },
    }
    db = api("POST", "/databases", body)
    print(f"[create] Deals db: {db['id']}")
    return db["id"]


def ensure_relation_db(parent_id, title, emoji, deals_db_id, extra_props):
    existing = find_child_database(parent_id, title)
    properties = {
        "Name": {"title": {}},
        "Deal": {
            "relation": {"database_id": deals_db_id, "single_property": {}}
        },
    }
    properties.update(extra_props)
    if existing:
        print(f"[reuse] {title} db: {existing}")
        return existing
    body = {
        "parent": {"type": "page_id", "page_id": parent_id},
        "title": [{"type": "text", "text": {"content": title}}],
        "icon": {"type": "emoji", "emoji": emoji},
        "properties": properties,
    }
    db = api("POST", "/databases", body)
    print(f"[create] {title} db: {db['id']}")
    return db["id"]


def patch_wrangler(deals, transcripts, pitches):
    text = WRANGLER_TOML.read_text()
    replacements = {
        "NOTION_DEALS_DB_ID": deals,
        "NOTION_TRANSCRIPTS_DB_ID": transcripts,
        "NOTION_PITCH_ARTIFACTS_DB_ID": pitches,
    }
    for key, val in replacements.items():
        text = re.sub(
            rf'{key}\s*=\s*"[^"]*"',
            f'{key} = "{val}"',
            text,
        )
    WRANGLER_TOML.write_text(text)
    print(f"[write] {WRANGLER_TOML}")


def main():
    pipeline_id = ensure_sales_pipeline_page()
    deals_id = ensure_deals_db(pipeline_id)
    transcripts_id = ensure_relation_db(
        pipeline_id,
        "Transcripts",
        "🎙️",
        deals_id,
        {
            "Started At": {"date": {}},
            "Summary": {"rich_text": {}},
            "Source": {
                "select": {
                    "options": [
                        {"name": "Granola", "color": "purple"},
                        {"name": "Google Meet (Gemini)", "color": "blue"},
                        {"name": "Whisper (manual)", "color": "gray"},
                    ]
                }
            },
        },
    )
    pitches_id = ensure_relation_db(
        pipeline_id,
        "Pitch Artifacts",
        "📄",
        deals_id,
        {
            "PDF Key": {"rich_text": {}},
            "Email Subject": {"rich_text": {}},
            "Status": {
                "select": {
                    "options": [
                        {"name": "Draft", "color": "gray"},
                        {"name": "Sent", "color": "blue"},
                        {"name": "Won", "color": "green"},
                        {"name": "Lost", "color": "red"},
                    ]
                }
            },
        },
    )

    print()
    print("=== IDs ===")
    print(f"Sales Pipeline page : {pipeline_id}")
    print(f"Deals db           : {deals_id}")
    print(f"Transcripts db     : {transcripts_id}")
    print(f"Pitch Artifacts db : {pitches_id}")

    patch_wrangler(deals_id, transcripts_id, pitches_id)


if __name__ == "__main__":
    main()

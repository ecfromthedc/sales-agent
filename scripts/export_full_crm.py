#!/usr/bin/env python3
"""
Export ALL records from the Rising Tides CRM Notion database.
Uses the Notion API with pagination to get every single record.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

DATABASE_ID = "1961465bb82980c9a1b5c4cb3284149a"
OUTPUT_PATH = os.path.join(os.path.dirname(__file__), "full_crm_export.json")

def get_notion_key():
    """Try multiple sources for the Notion API key."""
    # Check env
    key = os.environ.get("NOTION_API_KEY")
    if key:
        return key

    # Check .dev.vars
    dev_vars = os.path.join(os.path.dirname(__file__), "..", ".dev.vars")
    if os.path.exists(dev_vars):
        with open(dev_vars) as f:
            for line in f:
                line = line.strip()
                if line.startswith("NOTION_API_KEY="):
                    return line.split("=", 1)[1].strip()

    # Check wrangler secrets (won't work but try)
    # Check common env files
    for path in ["~/.env", "~/.notion_key"]:
        expanded = os.path.expanduser(path)
        if os.path.exists(expanded):
            with open(expanded) as f:
                for line in f:
                    if "NOTION" in line and "=" in line:
                        return line.split("=", 1)[1].strip()

    return None


def query_database(api_key, database_id, start_cursor=None):
    """Query a Notion database with pagination."""
    url = f"https://api.notion.com/v1/databases/{database_id}/query"

    body = {"page_size": 100}
    if start_cursor:
        body["start_cursor"] = start_cursor

    data = json.dumps(body).encode("utf-8")

    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Notion-Version", "2022-06-28")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        raise


def extract_property(prop):
    """Extract a readable value from a Notion property object."""
    if prop is None:
        return None

    ptype = prop.get("type")

    if ptype == "title":
        parts = prop.get("title", [])
        return "".join(p.get("plain_text", "") for p in parts).strip() or None

    elif ptype == "rich_text":
        parts = prop.get("rich_text", [])
        return "".join(p.get("plain_text", "") for p in parts).strip() or None

    elif ptype == "number":
        return prop.get("number")

    elif ptype == "select":
        sel = prop.get("select")
        return sel.get("name") if sel else None

    elif ptype == "multi_select":
        opts = prop.get("multi_select", [])
        return [o.get("name") for o in opts] if opts else []

    elif ptype == "status":
        st = prop.get("status")
        return st.get("name") if st else None

    elif ptype == "checkbox":
        return prop.get("checkbox", False)

    elif ptype == "email":
        return prop.get("email")

    elif ptype == "url":
        return prop.get("url")

    elif ptype == "date":
        d = prop.get("date")
        if d:
            return d.get("start")
        return None

    elif ptype == "people":
        people = prop.get("people", [])
        return [p.get("name", p.get("id")) for p in people]

    else:
        return str(prop)


def process_page(page):
    """Extract CRM record from a Notion page object."""
    props = page.get("properties", {})
    page_id = page.get("id", "")

    return {
        "artist_name": extract_property(props.get("Artist Name")),
        "song_name": extract_property(props.get("Song Name")),
        "label": extract_property(props.get("Label/Distro Partner")),
        "contact_email": extract_property(props.get("Key Contact Email")),
        "contact_name": extract_property(props.get("Your Name")),
        "contact_role": extract_property(props.get("Your Role")),
        "campaign_stage": extract_property(props.get("Campaign Stage")),
        "pipeline_status": extract_property(props.get("Pipeline Status")),
        "media_spend": extract_property(props.get("Media Spend")),
        "future_potential": extract_property(props.get("Future potencial")),
        "round": extract_property(props.get("Round")),
        "project_lead": extract_property(props.get("Project Lead")),
        "desired_start_date": extract_property(props.get("Desired Start Date")),
        "tiktok_progress": extract_property(props.get("TikTok")),
        "instagram_progress": extract_property(props.get("Instagram")),
        "content_types": extract_property(props.get("Types of Content Creators")),
        "notion_page_id": page_id,
        "notion_url": f"https://www.notion.so/{page_id.replace('-', '')}",
        "created_time": page.get("created_time"),
    }


def main():
    api_key = get_notion_key()
    if not api_key:
        print("ERROR: No NOTION_API_KEY found.", file=sys.stderr)
        print("Set it via: export NOTION_API_KEY=secret_...", file=sys.stderr)
        sys.exit(1)

    print(f"Using Notion API key: {api_key[:12]}...")
    print(f"Querying database: {DATABASE_ID}")

    all_records = []
    has_more = True
    start_cursor = None
    page_num = 0

    while has_more:
        page_num += 1
        print(f"  Fetching page {page_num}...", end=" ", flush=True)

        result = query_database(api_key, DATABASE_ID, start_cursor)

        pages = result.get("results", [])
        has_more = result.get("has_more", False)
        start_cursor = result.get("next_cursor")

        for page in pages:
            record = process_page(page)
            all_records.append(record)

        print(f"got {len(pages)} records (total: {len(all_records)})")

        if has_more:
            time.sleep(0.35)  # Rate limit: ~3 req/sec

    print(f"\nTotal records fetched: {len(all_records)}")

    # Generate summary
    stages = {}
    labels = {}
    spends = []
    artists = set()

    for r in all_records:
        # Stage distribution
        stage = r["campaign_stage"] or "Unknown"
        stages[stage] = stages.get(stage, 0) + 1

        # Label distribution
        label = r["label"] or "Unknown"
        if label.strip():
            labels[label.strip()] = labels.get(label.strip(), 0) + 1

        # Spend
        if r["media_spend"] is not None:
            spends.append(r["media_spend"])

        # Unique artists
        if r["artist_name"]:
            artists.add(r["artist_name"].strip().lower())

    summary = {
        "total_records": len(all_records),
        "unique_artists": len(artists),
        "campaign_stage_distribution": dict(sorted(stages.items(), key=lambda x: -x[1])),
        "label_distribution": dict(sorted(labels.items(), key=lambda x: -x[1])[:30]),
        "spend_stats": {
            "total": sum(spends),
            "average": round(sum(spends) / len(spends), 2) if spends else 0,
            "min": min(spends) if spends else 0,
            "max": max(spends) if spends else 0,
            "records_with_spend": len(spends),
        },
    }

    output = {
        "export_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "database_id": DATABASE_ID,
        "summary": summary,
        "records": all_records,
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2, default=str)

    print(f"\nExport written to: {OUTPUT_PATH}")
    print(f"\n=== SUMMARY ===")
    print(f"Total campaign entries: {len(all_records)}")
    print(f"Unique artists: {len(artists)}")
    print(f"\nCampaign Stage Distribution:")
    for stage, count in sorted(stages.items(), key=lambda x: -x[1]):
        print(f"  {stage}: {count}")
    print(f"\nTop Labels:")
    for label, count in sorted(labels.items(), key=lambda x: -x[1])[:15]:
        print(f"  {label}: {count}")
    print(f"\nSpend Stats:")
    print(f"  Total: ${sum(spends):,.0f}")
    print(f"  Average: ${sum(spends)/len(spends):,.0f}" if spends else "  No spend data")
    print(f"  Min: ${min(spends):,.0f}" if spends else "")
    print(f"  Max: ${max(spends):,.0f}" if spends else "")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Sync pre-call briefs from Notion Deals DB → Obsidian vault.

Pulls deals with status "Briefed" (or later) that don't yet have a local
Obsidian file, and writes each brief as a markdown note with frontmatter.

Run manually or via cron (every 5 min matches the Worker's cadence):
  python3 scripts/sync_briefs_to_obsidian.py

Env vars (auto-loaded from .dev.vars if present):
  NOTION_API_KEY          — Notion integration token
  NOTION_DEALS_DB_ID      — Deals database ID (from wrangler.toml)
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

# --- Config ---

SCRIPT_DIR = Path(__file__).parent
REPO_DIR = SCRIPT_DIR.parent
OBSIDIAN_DIR = Path.home() / "Documents" / "Obsidian Vault" / "Rising Tides OS" / "Sales Briefs"
SYNC_MARKER_DIR = Path.home() / ".claude" / "state" / "sales-agent"

NOTION_API_VERSION = "2022-06-28"


def load_dev_vars() -> dict[str, str]:
    """Load .dev.vars file into environment (key=value format)."""
    dev_vars_path = REPO_DIR / ".dev.vars"
    loaded = {}
    if dev_vars_path.exists():
        for line in dev_vars_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()
                if key and val:
                    os.environ.setdefault(key, val)
                    loaded[key] = val
    return loaded


def notion_request(endpoint: str, method: str = "POST", body: dict | None = None) -> dict:
    api_key = os.environ.get("NOTION_API_KEY", "")
    if not api_key:
        raise RuntimeError("NOTION_API_KEY not set")

    url = f"https://api.notion.com/v1/{endpoint}"
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Notion-Version", NOTION_API_VERSION)
    req.add_header("Content-Type", "application/json")

    try:
        with urlopen(req) as resp:
            return json.loads(resp.read())
    except HTTPError as e:
        err_body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"Notion API {e.code}: {err_body}") from e


def query_recent_deals() -> list[dict]:
    """Query Notion Deals DB for recent briefed deals."""
    db_id = os.environ.get("NOTION_DEALS_DB_ID", "")
    if not db_id:
        raise RuntimeError("NOTION_DEALS_DB_ID not set")

    result = notion_request(f"databases/{db_id}/query", body={
        "filter": {
            "or": [
                {"property": "Status", "select": {"equals": "Briefed"}},
                {"property": "Status", "select": {"equals": "Called"}},
                {"property": "Status", "select": {"equals": "Pitched"}},
                {"property": "Status", "select": {"equals": "Won"}},
            ],
        },
        "sorts": [{"timestamp": "created_time", "direction": "descending"}],
        "page_size": 20,
    })

    return result.get("results", [])


def extract_deal_info(page: dict) -> dict | None:
    """Extract relevant fields from a Notion deal page."""
    props = page.get("properties", {})

    def get_title(prop: dict) -> str:
        titles = prop.get("title", [])
        return "".join(t.get("plain_text", "") for t in titles)

    def get_rich_text(prop: dict) -> str:
        texts = prop.get("rich_text", [])
        return "".join(t.get("plain_text", "") for t in texts)

    def get_select(prop: dict) -> str:
        s = prop.get("select")
        return s.get("name", "") if s else ""

    def get_date(prop: dict) -> str:
        d = prop.get("date")
        return d.get("start", "") if d else ""

    def get_email(prop: dict) -> str:
        return prop.get("email", "") or ""

    # Try common property names (adjust if schema differs)
    name = ""
    email = ""
    status = ""
    meeting_date = ""
    brief = ""

    for key, val in props.items():
        key_lower = key.lower()
        ptype = val.get("type", "")

        if ptype == "title":
            name = get_title(val)
        elif "email" in key_lower and ptype == "email":
            email = get_email(val)
        elif "status" in key_lower and ptype == "select":
            status = get_select(val)
        elif "meeting" in key_lower and ptype == "date":
            meeting_date = get_date(val)
        elif "brief" in key_lower and ptype == "rich_text":
            brief = get_rich_text(val)

    if not name and not email:
        return None

    return {
        "id": page["id"],
        "name": name,
        "email": email,
        "status": status,
        "meeting_date": meeting_date,
        "brief": brief,
        "created": page.get("created_time", ""),
        "url": page.get("url", ""),
    }


def get_brief_content(page_id: str) -> str:
    """Fetch the full page content (blocks) as markdown."""
    blocks = notion_request(f"blocks/{page_id}/children", method="GET")
    lines = []

    for block in blocks.get("results", []):
        btype = block.get("type", "")
        data = block.get(btype, {})

        if btype in ("paragraph", "bulleted_list_item", "numbered_list_item"):
            texts = data.get("rich_text", [])
            text = "".join(t.get("plain_text", "") for t in texts)
            if btype == "bulleted_list_item":
                text = f"- {text}"
            elif btype == "numbered_list_item":
                text = f"1. {text}"
            lines.append(text)
        elif btype.startswith("heading_"):
            level = int(btype[-1])
            texts = data.get("rich_text", [])
            text = "".join(t.get("plain_text", "") for t in texts)
            lines.append(f"{'#' * level} {text}")
        elif btype == "divider":
            lines.append("---")

    return "\n\n".join(lines)


def sanitize_filename(name: str) -> str:
    """Make a string safe for filesystem use."""
    return re.sub(r'[<>:"/\\|?*]', "", name).strip()[:100]


def sync_deal_to_obsidian(deal: dict) -> bool:
    """Write a deal brief to Obsidian if not already synced."""
    OBSIDIAN_DIR.mkdir(parents=True, exist_ok=True)
    SYNC_MARKER_DIR.mkdir(parents=True, exist_ok=True)

    marker_file = SYNC_MARKER_DIR / f"{deal['id']}.synced"
    if marker_file.exists():
        return False  # already synced

    # Get full brief content from page blocks
    brief_content = deal.get("brief", "")
    if not brief_content:
        brief_content = get_brief_content(deal["id"])

    if not brief_content:
        return False  # no content to sync

    # Build filename
    date_prefix = ""
    if deal["meeting_date"]:
        try:
            dt = datetime.fromisoformat(deal["meeting_date"].replace("Z", "+00:00"))
            date_prefix = dt.strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            pass
    if not date_prefix:
        date_prefix = datetime.now().strftime("%Y-%m-%d")

    safe_name = sanitize_filename(deal["name"]) or sanitize_filename(deal["email"]) or deal["id"][:8]
    filename = f"{date_prefix} - {safe_name} - Pre-Call Brief.md"
    filepath = OBSIDIAN_DIR / filename

    # Build frontmatter + content
    frontmatter = {
        "type": "sales-brief",
        "prospect": deal["name"],
        "email": deal["email"],
        "status": deal["status"],
        "meeting_date": deal["meeting_date"],
        "notion_url": deal["url"],
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }

    fm_lines = ["---"]
    for k, v in frontmatter.items():
        fm_lines.append(f"{k}: \"{v}\"")
    fm_lines.append("---")

    content = "\n".join(fm_lines) + "\n\n" + brief_content

    filepath.write_text(content, encoding="utf-8")
    marker_file.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")

    print(f"  ✓ Synced: {filename}")
    return True


def main():
    load_dev_vars()

    # Also load from wrangler.toml vars
    wrangler_toml = REPO_DIR / "wrangler.toml"
    if wrangler_toml.exists():
        for line in wrangler_toml.read_text().splitlines():
            line = line.strip()
            if line.startswith("NOTION_DEALS_DB_ID"):
                val = line.split("=", 1)[1].strip().strip('"').strip("'")
                os.environ.setdefault("NOTION_DEALS_DB_ID", val)

    print("Syncing briefs from Notion → Obsidian...")
    print(f"  Target: {OBSIDIAN_DIR}")

    deals = query_recent_deals()
    print(f"  Found {len(deals)} deals in Notion")

    synced = 0
    for page in deals:
        deal = extract_deal_info(page)
        if not deal:
            continue
        try:
            if sync_deal_to_obsidian(deal):
                synced += 1
        except Exception as e:
            print(f"  ✗ Failed {deal.get('name', 'unknown')}: {e}")

    print(f"  Done — {synced} new briefs synced")


if __name__ == "__main__":
    main()

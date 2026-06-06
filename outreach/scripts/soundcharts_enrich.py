"""
Soundcharts enrichment for Henry's intel database.
Pulls: Spotify followers/listeners, TikTok followers, Instagram followers, YouTube subs, song catalog.
Budget: 1,000 requests on free tier. Strategy: 2 calls per artist (lookup + audience), prioritize RT clients.

Usage: python3 scripts/soundcharts_enrich.py
"""
import json
import os
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent.parent / ".dev.vars")

APP_ID = "ECROMARTIE-API_4DB1DBEB"
API_KEY = "14aca325526222c6"
BASE = "https://customer.api.soundcharts.com/api/v2"
DB = "henry_intel"
PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DELAY = 0.15  # 10K req/min limit — we can go fast


def run_sql(sql: str) -> str:
    result = subprocess.run([PSQL, DB, "-t", "-c", sql], capture_output=True, text=True)
    return result.stdout.strip()


def escape(val) -> str:
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"


requests_used = 0


def sc_get(path: str) -> dict | None:
    global requests_used
    url = f"{BASE}/{path}"
    req = urllib.request.Request(url)
    req.add_header("x-app-id", APP_ID)
    req.add_header("x-api-key", API_KEY)
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            requests_used += 1
            remaining = resp.headers.get("x-quota-remaining", "?")
            if requests_used % 50 == 0:
                print(f"    [{requests_used} requests used, {remaining} remaining]", flush=True)
            time.sleep(DELAY)
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        if e.code == 429:
            retry = int(e.headers.get("x-ratelimit-reset", "5"))
            print(f"    [rate-limit] sleeping {retry}s...", flush=True)
            time.sleep(retry)
            return sc_get(path)
        if e.code in (404, 403):
            return None
        return None
    except Exception:
        return None


def lookup_artist(spotify_id: str) -> str | None:
    """Get Soundcharts UUID from Spotify ID."""
    data = sc_get(f"artist/by-platform/spotify/{spotify_id}")
    if not data or data.get("errors"):
        return None
    return data.get("object", {}).get("uuid")


def lookup_artist_by_name(name: str) -> tuple[str | None, dict | None]:
    """Fallback: search by slug (name with hyphens)."""
    slug = name.lower().replace(" ", "-").replace("'", "").replace("&", "and")
    data = sc_get(f"artist/by-slug/{slug}")
    if data and not data.get("errors"):
        obj = data.get("object", {})
        return obj.get("uuid"), obj
    return None, None


def get_all_audience(uuid: str) -> dict:
    """Get latest follower counts across all platforms in one pass."""
    stats = {}
    for platform in ["spotify", "tiktok", "instagram", "youtube"]:
        data = sc_get(f"artist/{uuid}/audience/{platform}?period=latest")
        if data and not data.get("errors"):
            items = data.get("items", [])
            if items:
                latest = items[-1]  # most recent
                stats[platform] = {
                    "followers": latest.get("followerCount"),
                    "views": latest.get("viewCount"),
                    "posts": latest.get("postCount"),
                }
    return stats


def get_spotify_listeners(uuid: str) -> int | None:
    """Get current Spotify monthly listeners."""
    data = sc_get(f"artist/{uuid}/streaming/spotify/listening?period=latest")
    if data and not data.get("errors"):
        items = data.get("items", [])
        if items:
            return items[-1].get("value")
    return None


def enrich_artist(artist_id: int, name: str, spotify_id: str | None) -> bool:
    """Full enrichment for one artist."""
    uuid = None

    # Try Spotify ID first (1 request), fallback to slug (1 request)
    if spotify_id:
        uuid = lookup_artist(spotify_id)
    if not uuid:
        uuid, _ = lookup_artist_by_name(name)
    if not uuid:
        return False

    # Get cross-platform audience (4 requests max)
    audience = get_all_audience(uuid)

    # Get Spotify monthly listeners (1 request)
    monthly = get_spotify_listeners(uuid)

    # Build SQL update
    updates = []

    sp = audience.get("spotify", {})
    if sp.get("followers"):
        updates.append(f"followers = {sp['followers']}")

    if monthly:
        updates.append(f"monthly_listeners = {monthly}")

    # Tier from followers
    f = sp.get("followers")
    if f:
        if f >= 5000000:
            updates.append("tier = 'major'")
        elif f >= 1000000:
            updates.append("tier = 'established'")
        elif f >= 100000:
            updates.append("tier = 'mid'")
        else:
            updates.append("tier = 'emerging'")

    # Cross-platform stats as JSON in notes
    social = {}
    for platform, data in audience.items():
        if data.get("followers"):
            social[f"{platform}_followers"] = data["followers"]
        if data.get("views"):
            social[f"{platform}_views"] = data["views"]
    if monthly:
        social["spotify_monthly_listeners"] = monthly

    if social:
        sj = json.dumps(social).replace("'", "''")
        updates.append(f"notes = COALESCE(notes, '') || ' [Soundcharts] ' || '{sj}'")

    if updates:
        sql = f"UPDATE artists SET {', '.join(updates)} WHERE id = {artist_id};"
        run_sql(sql)
        return True
    return False


def main() -> None:
    # Get artists prioritized: RT clients first, then by existing follower data gaps
    rows = run_sql("""
        SELECT id, name, spotify_id FROM artists
        WHERE has_worked_with_rt = true
        ORDER BY followers NULLS FIRST, name
    """)

    artists = []
    for line in rows.split("\n"):
        line = line.strip()
        if not line or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 3:
            sid = parts[2] if parts[2] else None
            artists.append((int(parts[0]), parts[1], sid))

    # Budget: ~1000 requests. Each artist uses 2-6 requests.
    # Prioritize: artists without follower data first, then fill rest
    # Cap at ~150 artists (150 * 6 = 900 requests, leaves buffer)
    max_artists = 150
    artists = artists[:max_artists]

    print(f"Enriching {len(artists)} RT client artists from Soundcharts...")
    print(f"Budget: ~1000 requests, estimating ~6 per artist\n", flush=True)

    enriched = 0
    not_found = 0

    for i, (aid, name, sid) in enumerate(artists):
        print(f"[{i+1}/{len(artists)}] {name}...", end=" ", flush=True)

        if requests_used >= 950:
            print(f"\n[BUDGET] Stopping at {requests_used} requests to preserve buffer.")
            break

        if enrich_artist(aid, name, sid):
            enriched += 1
            print("OK")
        else:
            not_found += 1
            print("not found")

    # Log
    run_sql(f"""INSERT INTO scan_log (scan_type, artists_scanned, metadata, completed_at)
VALUES ('soundcharts_enrichment', {len(artists)},
  '{{"enriched": {enriched}, "not_found": {not_found}, "requests_used": {requests_used}}}',
  now());""")

    print(f"\n=== Soundcharts Enrichment Complete ===")
    print(f"Artists processed: {i+1}")
    print(f"Enriched: {enriched}")
    print(f"Not found: {not_found}")
    print(f"API requests used: {requests_used}")

    # Verify
    print(f"\nDB stats:")
    print(f"  With followers: {run_sql('SELECT count(*) FROM artists WHERE followers IS NOT NULL;')}")
    print(f"  With monthly listeners: {run_sql('SELECT count(*) FROM artists WHERE monthly_listeners IS NOT NULL;')}")


if __name__ == "__main__":
    main()

"""
Songstats data extraction for Henry's ecosystem map.
Pulls artist stats across all platforms, fills Postgres.

Usage:
    python3 scripts/songstats_extract.py

Requires SONGSTATS_API_KEY in .dev.vars or environment.
"""
import json
import os
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
from dotenv import load_dotenv

# Load secrets
load_dotenv(Path(__file__).parent.parent / ".dev.vars")
API_KEY = os.environ.get("SONGSTATS_API_KEY", "")
if not API_KEY:
    print("ERROR: Set SONGSTATS_API_KEY in .dev.vars")
    exit(1)

DB = "henry_intel"
PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
BASE_URL = "https://api.songstats.com/enterprise/v1"
DELAY = 0.5  # 10 req/sec limit


def run_sql(sql: str) -> str:
    result = subprocess.run(
        [PSQL, DB, "-t", "-c", sql], capture_output=True, text=True
    )
    return result.stdout.strip()


def escape(val) -> str:
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"


def ss_get(path: str, params: dict | None = None) -> dict | None:
    """GET from Songstats API."""
    query = ""
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{BASE_URL}/{path}?{query}" if query else f"{BASE_URL}/{path}"

    req = urllib.request.Request(url)
    req.add_header("apikey", API_KEY)
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            time.sleep(DELAY)
            return data
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print(f"    [rate-limit] sleeping 5s...")
            time.sleep(5)
            return ss_get(path, params)
        if e.code == 404:
            return None
        body = e.read().decode() if e.readable() else ""
        print(f"    [error] HTTP {e.code}: {body[:200]}")
        return None
    except Exception as e:
        print(f"    [error] {e}")
        return None


def search_artist(name: str) -> dict | None:
    """Search for an artist on Songstats. Returns first match."""
    # Try the info endpoint with a search
    data = ss_get("artists/info", {"q": name})
    if data and data.get("stats"):
        return data
    return None


def get_artist_stats(songstats_id: str, source: str = "spotify") -> dict | None:
    """Get stats for an artist from a specific source."""
    return ss_get("artists/stats", {"songstats_artist_id": songstats_id, "source": source})


def get_artist_info(songstats_id: str) -> dict | None:
    """Get artist metadata."""
    return ss_get("artists/info", {"songstats_artist_id": songstats_id})


def enrich_artist(artist_id: int, name: str) -> bool:
    """Search Songstats for an artist and update Postgres."""
    # Search
    info = search_artist(name)
    if not info:
        return False

    # Extract what we can
    artist_data = info.get("data", info)
    ss_id = artist_data.get("songstats_artist_id", "")

    if not ss_id:
        return False

    # Get Spotify stats
    spotify_stats = get_artist_stats(ss_id, "spotify")
    tiktok_stats = get_artist_stats(ss_id, "tiktok")
    instagram_stats = get_artist_stats(ss_id, "instagram")
    youtube_stats = get_artist_stats(ss_id, "youtube")

    # Parse stats
    sp_data = (spotify_stats or {}).get("data", {}).get("stats", {})
    tt_data = (tiktok_stats or {}).get("data", {}).get("stats", {})
    ig_data = (instagram_stats or {}).get("data", {}).get("stats", {})
    yt_data = (youtube_stats or {}).get("data", {}).get("stats", {})

    sp_followers = sp_data.get("followers_total")
    sp_monthly = sp_data.get("monthly_listeners_current")
    tt_followers = tt_data.get("followers_total")
    ig_followers = ig_data.get("followers_total")
    yt_subs = yt_data.get("subscribers_total")

    # Get genres and label from info
    genres = artist_data.get("genres", [])
    labels = artist_data.get("labels", [])
    label_name = labels[0].get("name") if labels else None

    # Build update
    updates = []
    if sp_followers:
        updates.append(f"followers = {sp_followers}")
    if sp_monthly:
        updates.append(f"monthly_listeners = {sp_monthly}")
    if genres:
        genre_arr = ",".join(f'"{g}"' for g in genres[:10])
        updates.append(f"genres = '{{{genre_arr}}}'")
    if label_name:
        updates.append(f"label_name_raw = COALESCE(label_name_raw, {escape(label_name)})")

    # Store cross-platform stats as JSON in notes
    social_stats = {}
    if tt_followers:
        social_stats["tiktok_followers"] = tt_followers
    if ig_followers:
        social_stats["instagram_followers"] = ig_followers
    if yt_subs:
        social_stats["youtube_subscribers"] = yt_subs
    if sp_monthly:
        social_stats["spotify_monthly_listeners"] = sp_monthly

    if social_stats:
        stats_json = json.dumps(social_stats).replace("'", "''")
        updates.append(f"notes = COALESCE(notes, '') || ' [Songstats] ' || '{stats_json}'")

    # Tier classification
    if sp_followers:
        if sp_followers >= 5000000:
            updates.append("tier = 'major'")
        elif sp_followers >= 1000000:
            updates.append("tier = 'established'")
        elif sp_followers >= 100000:
            updates.append("tier = 'mid'")
        else:
            updates.append("tier = 'emerging'")

    if updates:
        sql = f"UPDATE artists SET {', '.join(updates)} WHERE id = {artist_id};"
        run_sql(sql)
        return True
    return False


def main() -> None:
    # First test the API
    print("Testing Songstats API connection...")
    test = ss_get("info/sources")
    if not test:
        print("API connection failed. Check your API key.")
        return
    print(f"Connected. Available sources: {json.dumps(test.get('data', {}).get('sources', []), indent=2)[:500]}\n")

    # Get all artists ordered by priority (clients first, then by followers)
    rows = run_sql("""
        SELECT id, name FROM artists
        ORDER BY has_worked_with_rt DESC, followers DESC NULLS LAST, name
    """)

    artists = []
    for line in rows.split("\n"):
        line = line.strip()
        if not line or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 2:
            artists.append((int(parts[0]), parts[1]))

    print(f"Enriching {len(artists)} artists from Songstats...\n")

    enriched = 0
    not_found = 0
    errors = 0

    for i, (aid, name) in enumerate(artists):
        print(f"[{i+1}/{len(artists)}] {name}...", end=" ", flush=True)
        try:
            if enrich_artist(aid, name):
                enriched += 1
                print("OK")
            else:
                not_found += 1
                print("not found")
        except Exception as e:
            errors += 1
            print(f"error: {e}")

    # Log the scan
    run_sql(f"""INSERT INTO scan_log (scan_type, artists_scanned, metadata, completed_at)
VALUES ('songstats_enrichment', {len(artists)},
  '{{"enriched": {enriched}, "not_found": {not_found}, "errors": {errors}}}',
  now());""")

    print(f"\n=== Songstats Enrichment Complete ===")
    print(f"Processed: {len(artists)}")
    print(f"Enriched: {enriched}")
    print(f"Not found: {not_found}")
    print(f"Errors: {errors}")

    # Verify
    print(f"\nDB stats:")
    print(f"  Artists with followers: {run_sql('SELECT count(*) FROM artists WHERE followers IS NOT NULL;')}")
    print(f"  Artists with monthly listeners: {run_sql('SELECT count(*) FROM artists WHERE monthly_listeners IS NOT NULL;')}")
    print(f"  Artists with genres: {run_sql('SELECT count(*) FROM artists WHERE genres IS NOT NULL AND array_length(genres,1) > 0;')}")


if __name__ == "__main__":
    main()

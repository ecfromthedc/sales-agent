"""
Enrich henry_intel Postgres with MusicBrainz data.
Pulls: label, distributor, country, disambiguation, release history.
No API key needed — just a user-agent header and 1 req/sec rate limit.
"""
import json
import subprocess
import time
import urllib.request
import urllib.parse
import urllib.error
from typing import Any

DB = "henry_intel"
PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
MB_API = "https://musicbrainz.org/ws/2"
USER_AGENT = "HenryOutreachAgent/1.0 (ec@risingtidesent.com)"
DELAY = 1.1  # MusicBrainz requires 1 req/sec


def run_sql(sql: str) -> str:
    result = subprocess.run(
        [PSQL, DB, "-t", "-c", sql],
        capture_output=True, text=True
    )
    return result.stdout.strip()


def escape(val: str | None) -> str:
    if val is None:
        return "NULL"
    return "'" + str(val).replace("'", "''") + "'"


def mb_get(path: str, params: dict[str, str] | None = None) -> Any:
    """GET from MusicBrainz API with rate limiting."""
    if params is None:
        params = {}
    params["fmt"] = "json"
    query = urllib.parse.urlencode(params)
    url = f"{MB_API}/{path}?{query}"

    req = urllib.request.Request(url)
    req.add_header("User-Agent", USER_AGENT)
    req.add_header("Accept", "application/json")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            time.sleep(DELAY)
            return data
    except urllib.error.HTTPError as e:
        if e.code == 503:
            print(f"    [rate-limit] 503, sleeping 3s...")
            time.sleep(3)
            return mb_get(path, params)  # retry once
        print(f"    [error] HTTP {e.code} for {path}")
        return None
    except Exception as e:
        print(f"    [error] {e}")
        return None


def search_artist(name: str) -> dict | None:
    """Search MusicBrainz for an artist by name."""
    data = mb_get("artist", {"query": f'artist:"{name}"', "limit": "5"})
    if not data or "artists" not in data:
        return None

    artists = data["artists"]
    if not artists:
        return None

    # Prefer exact match
    name_lower = name.lower()
    for a in artists:
        if a.get("name", "").lower() == name_lower:
            return a

    # Fall back to highest score
    return artists[0]


def get_artist_releases(mbid: str) -> list[dict]:
    """Get release groups for an artist."""
    data = mb_get(f"release-group", {
        "artist": mbid,
        "type": "album|single|ep",
        "limit": "10"
    })
    if not data:
        return []
    return data.get("release-groups", [])


def get_release_label(mbid: str) -> tuple[str | None, str | None]:
    """Get label and catalog info from a release group's first release."""
    data = mb_get(f"release-group/{mbid}", {"inc": "releases"})
    if not data:
        return None, None

    releases = data.get("releases", [])
    if not releases:
        return None, None

    # Get first release details with label info
    release_id = releases[0].get("id")
    if not release_id:
        return None, None

    release_data = mb_get(f"release/{release_id}", {"inc": "labels"})
    if not release_data:
        return None, None

    label_info = release_data.get("label-info", [])
    if not label_info:
        return None, None

    label_name = label_info[0].get("label", {}).get("name")

    # Check for distributor (sometimes second label entry)
    distributor = None
    for li in label_info:
        label = li.get("label", {})
        ltype = label.get("type") or ""
        if ltype and ("distributor" in ltype.lower() or "distribution" in ltype.lower()):
            distributor = label.get("name")
            break

    return label_name, distributor


def classify_area(area: dict | None) -> str | None:
    """Extract country from artist area."""
    if not area:
        return None
    return area.get("name")


def main() -> None:
    # Get all artists that need enrichment
    rows = run_sql("""
        SELECT id, name FROM artists
        ORDER BY
            has_worked_with_rt DESC,
            followers DESC NULLS LAST,
            name
    """)

    artists = []
    for line in rows.split("\n"):
        line = line.strip()
        if not line or "|" not in line:
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) >= 2:
            artists.append((int(parts[0]), parts[1]))

    print(f"Enriching {len(artists)} artists from MusicBrainz...\n")

    enriched = 0
    skipped = 0
    errors = 0
    release_count = 0

    for i, (artist_id, name) in enumerate(artists):
        print(f"[{i+1}/{len(artists)}] {name}...", end=" ", flush=True)

        mb_artist = search_artist(name)
        if not mb_artist:
            print("not found")
            skipped += 1
            continue

        mbid = mb_artist.get("id", "")
        mb_name = mb_artist.get("name", name)
        mb_type = mb_artist.get("type", "")
        mb_country = mb_artist.get("country")
        mb_area = classify_area(mb_artist.get("area"))
        mb_disambiguation = mb_artist.get("disambiguation", "")
        mb_score = mb_artist.get("score", 0)

        # Skip low-confidence matches
        if mb_score < 80 and mb_name.lower() != name.lower():
            print(f"low match ({mb_score}%, got '{mb_name}')")
            skipped += 1
            continue

        # Get releases to find label
        release_groups = get_artist_releases(mbid)
        label_name = None
        distributor = None

        if release_groups:
            # Try most recent release group first
            for rg in release_groups[:3]:
                rg_id = rg.get("id")
                if rg_id:
                    label_name, distributor = get_release_label(rg_id)
                    if label_name:
                        break

            # Count releases for the DB
            for rg in release_groups:
                rg_type = rg.get("primary-type", "").lower()
                rg_title = rg.get("title", "")
                rg_date = rg.get("first-release-date", "")

                release_type = "single"
                if rg_type == "album":
                    release_type = "album"
                elif rg_type == "ep":
                    release_type = "ep"

                if rg_title and rg_date:
                    insert_sql = f"""INSERT INTO releases (artist_id, name, release_date, release_type)
VALUES ({artist_id}, {escape(rg_title)}, {escape(rg_date) if len(rg_date) >= 4 else 'NULL'}, '{release_type}')
ON CONFLICT DO NOTHING;"""
                    run_sql(insert_sql)
                    release_count += 1

        # Determine independence
        is_indie = False
        if label_name:
            indie_signals = ["distrokid", "tunecore", "cdbaby", "cd baby",
                           "unitedmasters", "amuse", "landr", "self-released",
                           "bandcamp", "soundcloud", "independent"]
            label_lower = label_name.lower()
            name_lower = name.lower()
            is_indie = any(sig in label_lower for sig in indie_signals) or \
                       name_lower in label_lower or label_lower in name_lower

        # Update artist record
        updates = []
        if label_name and not run_sql(f"SELECT label_name_raw FROM artists WHERE id = {artist_id} AND label_name_raw IS NOT NULL;"):
            updates.append(f"label_name_raw = {escape(label_name)}")
        if label_name:
            updates.append(f"notes = COALESCE(notes, '') || ' [MB] label: {escape(label_name).strip(chr(39))}' || CASE WHEN {escape(distributor)} != 'NULL' THEN ', dist: {escape(distributor).strip(chr(39))}' ELSE '' END")
        if is_indie:
            updates.append("is_independent = true")

        if updates:
            update_sql = f"UPDATE artists SET {', '.join(updates)} WHERE id = {artist_id};"
            run_sql(update_sql)

        enriched += 1
        label_str = label_name or "no label found"
        print(f"OK — {label_str}")

    # Log the scan
    run_sql(f"""INSERT INTO scan_log (scan_type, artists_scanned, metadata)
VALUES ('musicbrainz_enrichment', {len(artists)}, '{{"enriched": {enriched}, "skipped": {skipped}, "errors": {errors}, "releases_added": {release_count}}}');""")

    print(f"\n=== MusicBrainz Enrichment Complete ===")
    print(f"Artists processed: {len(artists)}")
    print(f"Successfully enriched: {enriched}")
    print(f"Skipped (not found / low match): {skipped}")
    print(f"Releases added: {release_count}")

    # Quick verification
    print(f"\nDB totals:")
    print(f"  Artists: {run_sql('SELECT count(*) FROM artists;')}")
    print(f"  With label data: {run_sql('SELECT count(*) FROM artists WHERE label_name_raw IS NOT NULL;')}")
    print(f"  Releases: {run_sql('SELECT count(*) FROM releases;')}")
    print(f"  Independent: {run_sql('SELECT count(*) FROM artists WHERE is_independent;')}")


if __name__ == "__main__":
    main()

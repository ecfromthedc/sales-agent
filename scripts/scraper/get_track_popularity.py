"""
Spotify Track Popularity Scraper

Gets per-track popularity scores (0-100) using Spotify's embed token.
No API key needed. Runs from residential IP (Eric's machine).

Usage:
    python3 get_track_popularity.py <spotify_artist_url>
    python3 get_track_popularity.py <track_id1>,<track_id2>,<track_id3>

Output: JSON to stdout
    {"tracks": [{"id": "...", "name": "...", "popularity": 72, "streams": null}]}

Rate limits:
    - 1 request per embed token fetch
    - 1 request per batch (up to 50 tracks)
    - Normal use (2-3 briefs/day) will never trigger rate limits
    - Heavy testing (50+ calls) triggers 5hr cooldown per IP
"""

import sys
import json
import re
import httpx

EMBED_URL = "https://open.spotify.com/embed/artist/{artist_id}"
TRACKS_API = "https://api.spotify.com/v1/tracks"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


def get_embed_token(artist_id: str) -> str:
    """Get anonymous access token from Spotify's embed page."""
    client = httpx.Client(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=15,
    )
    resp = client.get(EMBED_URL.format(artist_id=artist_id))
    match = re.search(r'"accessToken"\s*:\s*"([^"]+)"', resp.text)
    if not match:
        raise RuntimeError("Could not extract embed token from Spotify")
    return match.group(1)


def get_track_popularity(track_ids: list[str], token: str) -> list[dict]:
    """Batch-fetch track popularity scores. Max 50 per call."""
    client = httpx.Client(timeout=15)
    resp = client.get(
        TRACKS_API,
        params={"ids": ",".join(track_ids[:50])},
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
    )

    if resp.status_code == 429:
        retry = resp.headers.get("retry-after", "unknown")
        raise RuntimeError(f"Rate limited. Retry after {retry}s")

    if resp.status_code != 200:
        raise RuntimeError(f"Spotify API error {resp.status_code}: {resp.text[:200]}")

    results = []
    for t in resp.json().get("tracks", []):
        if t:
            results.append({
                "id": t["id"],
                "name": t["name"],
                "popularity": t.get("popularity"),
                "duration_ms": t.get("duration_ms"),
                "album": t.get("album", {}).get("name"),
                "release_date": t.get("album", {}).get("release_date"),
                "explicit": t.get("explicit"),
            })
    return results


def extract_artist_id(url: str) -> str:
    """Extract Spotify artist ID from URL."""
    match = re.search(r"artist/([a-zA-Z0-9]{22})", url)
    if not match:
        raise ValueError(f"Invalid Spotify artist URL: {url}")
    return match.group(1)


def get_top_track_ids_from_embed(artist_id: str) -> list[str]:
    """Get top track IDs from the artist embed page data."""
    client = httpx.Client(
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        timeout=15,
    )
    resp = client.get(EMBED_URL.format(artist_id=artist_id))
    # The embed page includes track URIs
    track_ids = re.findall(r'"spotify:track:([a-zA-Z0-9]{22})"', resp.text)
    # Dedupe while preserving order
    seen = set()
    unique = []
    for tid in track_ids:
        if tid not in seen:
            seen.add(tid)
            unique.append(tid)
    return unique[:10]


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 get_track_popularity.py <spotify_artist_url_or_track_ids>")
        sys.exit(1)

    arg = sys.argv[1]

    if "spotify.com/artist" in arg:
        artist_id = extract_artist_id(arg)
        print(f"Artist ID: {artist_id}", file=sys.stderr)

        # Get top track IDs from embed page
        track_ids = get_top_track_ids_from_embed(artist_id)
        if not track_ids:
            print('{"error": "No track IDs found in embed page"}')
            sys.exit(1)
        print(f"Found {len(track_ids)} tracks", file=sys.stderr)

        # Get token and fetch popularity
        token = get_embed_token(artist_id)
        tracks = get_track_popularity(track_ids[:5], token)
    else:
        # Assume comma-separated track IDs
        track_ids = [t.strip() for t in arg.split(",")]
        # Need any artist ID just to get a token
        token = get_embed_token("6pvai2QB2c0defVI0UTFos")
        tracks = get_track_popularity(track_ids, token)

    print(json.dumps({"tracks": tracks}, indent=2))


if __name__ == "__main__":
    main()

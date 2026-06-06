#!/usr/bin/env python3.12
"""
spotify-ecosystem-map.py
------------------------
Builds an interactive Spotify artist ecosystem graph for Rising Tides CRM artists.

Outputs:
  - ecosystem-data.json   : raw graph data (nodes + edges)
  - ecosystem-map.html    : self-contained D3.js force-directed visualization

Usage:
    python3.12 scripts/spotify-ecosystem-map.py

Auth:
    Reads SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET from environment or
    a .env file at the project root (outreach-agent/.env or .dev.vars).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

import aiohttp
from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Project root = directory containing this script's parent (scripts/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load secrets from .env or .dev.vars (whichever exists)
for env_file in [PROJECT_ROOT / ".env", PROJECT_ROOT / ".dev.vars"]:
    if env_file.exists():
        load_dotenv(env_file)
        break

SPOTIFY_CLIENT_ID = os.environ.get("SPOTIFY_CLIENT_ID", "")
SPOTIFY_CLIENT_SECRET = os.environ.get("SPOTIFY_CLIENT_SECRET", "")

if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
    sys.exit(
        "ERROR: SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set in "
        "the environment or in .env / .dev.vars at the project root."
    )

# Force unbuffered output so we can see progress
import functools
print = functools.partial(print, flush=True)

# Output location — write to today's session folder
SESSION_FOLDER_SCRIPT = Path.home() / ".claude" / "hooks" / "session-folder.sh"

def get_session_folder() -> Path:
    try:
        result = subprocess.run(
            ["bash", str(SESSION_FOLDER_SCRIPT)],
            capture_output=True, text=True, timeout=10
        )
        folder = Path(result.stdout.strip())
        folder.mkdir(parents=True, exist_ok=True)
        return folder
    except Exception:
        fallback = PROJECT_ROOT / "output"
        fallback.mkdir(exist_ok=True)
        return fallback

OUTPUT_DIR = get_session_folder()
JSON_OUTPUT = OUTPUT_DIR / "ecosystem-data.json"
HTML_OUTPUT = OUTPUT_DIR / "ecosystem-map.html"

# Spotify API
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API_BASE = "https://api.spotify.com/v1"

# Rate limiting — conservative for basic Spotify app tier
MAX_CONCURRENT = 4
REQUEST_DELAY = 0.25  # seconds between batches

# Independent label signals (lowercase match)
INDIE_SIGNALS = {
    "independent", "distrokid", "tunecore", "cdbaby", "cd baby",
    "unitedmasters", "united masters", "amuse", "landr", "self-released",
    "self released", "bandcamp", "soundcloud",
}

# ---------------------------------------------------------------------------
# CRM artist list
# ---------------------------------------------------------------------------

RT_CLIENT_ARTISTS: list[str] = [
    "Emei", "Isaiah Rashad", "SZA", "Amble", "Stella Lefty", "Daniel Seavey",
    "Bella Kay", "Jake Marsh", "Tucker Wetmore", "Sam Barber", "Rachel Platten",
    "Caleb Hearn", "Amistat", "Bailey Spinn", "Mon Rovia", "Goldford", "Dasha",
    "Gavin Adcock", "Gregory Alan Isakov", "Myles Smith", "Wild Rivers",
    "Cam Whitcomb", "Lil Tjay", "Neil Young", "Pecos & The Rooftops",
    "Jake Wesley Rogers", "Honey BxBy", "Alex Sucks", "Gannon Fremin", "Cil",
    "Blake Whitten", "Alan Walker", "Sara Landry", "Electric Guest", "Haffway",
    "Haley Joelle", "Labrinth", "Phillip-Michael Scales", "GoldKimono", "Gunnar",
    "Flavia", "Ferester", "Quadeca", "Spencer Ludwig", "Transviolet", "Troy Ramey",
    "Family Company", "Nate Bergman", "Carter Faith", "Shaya Zamora",
    "Rayvn Lenae", "Twenty One Pilots", "Lelo", "Eurotripp", "Alex Aiono",
    "All American Rejects", "Diplo", "IDK", "Joey Valence & Brae",
    "Sam Macpherson", "Pressa", "Kaleb Cohen", "Nemahsis", "Limage",
    "Chris Burke", "Brady Toops", "Highup", "Manning Rothrock",
    "Just Seconds Apart", "Frayne Vibez", "SieteNameKeek", "Brooke Brazelton",
    "Kesley Bou", "Lily Fitts", "Hunter James", "Valley James", "Elvis Drew",
    "Sensure", "Zandros", "Mattilo", "Night Tales", "Them & I", "Roz.Wavv",
    "SXMPRA", "BagLuck", "Quail P", "TWINN", "Tyler Dial", "Colorblind",
    "LunchMoney Lewis", "Big Boss Vette", "Griefcat", "Jacob Slade",
    "Bobby Uncle", "Kami Kehoe", "Barney Bones", "Bovski", "OKAYVAL", "SOSA",
    "Scoot Teasley", "Wyclef Jean", "French Montana", "Rick Ross", "Bebe Rexha",
    "Noah Cyrus", "Mike Posner", "Teddy Swims", "Maisie Peters",
    "Warren Zeiders", "Forrest Frank", "San Holo", "Bailey Zimmerman",
    "Josiah and the Bonnevilles", "Liam St John",
]

# Normalised lookup set for O(1) "is RT client?" checks
RT_CLIENT_SET: set[str] = {name.lower() for name in RT_CLIENT_ARTISTS}

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class ArtistNode:
    id: str                          # Spotify artist ID
    name: str
    followers: int
    genres: list[str]
    label: str                       # Latest album label (or "Unknown")
    is_independent: bool
    is_rt_client: bool
    spotify_url: str
    image_url: str                   # First image if available
    related_ids: list[str] = field(default_factory=list)

@dataclass
class GraphEdge:
    source: str   # Spotify ID
    target: str   # Spotify ID

@dataclass
class EcosystemGraph:
    nodes: list[ArtistNode] = field(default_factory=list)
    edges: list[GraphEdge] = field(default_factory=list)

# ---------------------------------------------------------------------------
# Spotify client
# ---------------------------------------------------------------------------

class SpotifyClient:
    def __init__(self, session: aiohttp.ClientSession, token: str) -> None:
        self._session = session
        self._token = token
        self._headers = {"Authorization": f"Bearer {token}"}
        self._semaphore = asyncio.Semaphore(MAX_CONCURRENT)

    async def _get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        async with self._semaphore:
            for attempt in range(4):
                try:
                    async with self._session.get(
                        url, headers=self._headers, params=params, timeout=aiohttp.ClientTimeout(total=15)
                    ) as resp:
                        if resp.status == 429:
                            retry_after = int(resp.headers.get("Retry-After", "5"))
                            print(f"  [rate-limit] sleeping {retry_after}s …")
                            await asyncio.sleep(retry_after)
                            continue
                        if resp.status == 200:
                            return await resp.json()
                        if resp.status in (400, 404):
                            return None
                        await asyncio.sleep(1.5 ** attempt)
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    await asyncio.sleep(1.5 ** attempt)
            return None

    async def search_artist(self, name: str) -> Optional[dict]:
        """Return best-match artist object from search."""
        data = await self._get(
            f"{SPOTIFY_API_BASE}/search",
            params={"q": name, "type": "artist", "limit": 5}
        )
        if not data:
            return None
        items = data.get("artists", {}).get("items", [])
        if not items:
            return None
        # Prefer exact name match (case-insensitive), else take top result
        name_lower = name.lower()
        for item in items:
            if item.get("name", "").lower() == name_lower:
                return item
        return items[0]

    async def get_artist(self, artist_id: str) -> Optional[dict]:
        return await self._get(f"{SPOTIFY_API_BASE}/artists/{artist_id}")

    async def get_related_artists(self, artist_id: str) -> list[dict]:
        data = await self._get(f"{SPOTIFY_API_BASE}/artists/{artist_id}/related-artists")
        if not data:
            return []
        return data.get("artists", [])[:10]

    async def get_latest_album_label(self, artist_id: str) -> str:
        """Return the label from the artist's most-recent album."""
        data = await self._get(
            f"{SPOTIFY_API_BASE}/artists/{artist_id}/albums",
            params={"include_groups": "album,single", "limit": 5, "market": "US"}
        )
        if not data:
            return "Unknown"
        items = data.get("items", [])
        if not items:
            return "Unknown"
        # Fetch full album details for the latest item (has label field)
        album_id = items[0].get("id")
        if not album_id:
            return "Unknown"
        album = await self._get(f"{SPOTIFY_API_BASE}/albums/{album_id}")
        if not album:
            return "Unknown"
        return album.get("label", "Unknown") or "Unknown"


def classify_label(label: str, artist_name: str) -> tuple[str, bool]:
    """Return (label_display, is_independent)."""
    if not label or label == "Unknown":
        return "Unknown", False
    label_lower = label.lower()
    artist_lower = artist_name.lower()
    # Indie signal in label name?
    if any(sig in label_lower for sig in INDIE_SIGNALS):
        return label, True
    # Label name IS (or very closely matches) the artist name
    if artist_lower in label_lower or label_lower in artist_lower:
        return label, True
    return label, False


def pick_image(images: list[dict]) -> str:
    """Return smallest image URL (last in Spotify's list) or empty string."""
    if not images:
        return ""
    return images[-1].get("url", "")


# ---------------------------------------------------------------------------
# Core enrichment
# ---------------------------------------------------------------------------

async def enrich_artist(
    client: SpotifyClient,
    name: str,
    is_rt_client: bool,
) -> Optional[ArtistNode]:
    """Search + enrich a single artist."""
    search_result = await client.search_artist(name)
    if not search_result:
        print(f"  [skip] not found on Spotify: {name}")
        return None

    artist_id = search_result["id"]

    # Search results on basic apps lack followers/genres — fetch full profile
    artist_data = await client.get_artist(artist_id)
    if not artist_data:
        artist_data = search_result

    spotify_name = artist_data.get("name", name)
    followers = artist_data.get("followers", {}).get("total", 0)
    genres = artist_data.get("genres", [])
    images = artist_data.get("images", [])
    spotify_url = artist_data.get("external_urls", {}).get("spotify", "")
    image_url = pick_image(images)

    # Related artists
    related = await client.get_related_artists(artist_id)
    related_ids = [r["id"] for r in related]

    # Label
    raw_label = await client.get_latest_album_label(artist_id)
    label, is_independent = classify_label(raw_label, spotify_name)

    await asyncio.sleep(REQUEST_DELAY)

    return ArtistNode(
        id=artist_id,
        name=spotify_name,
        followers=followers,
        genres=genres,
        label=label,
        is_independent=is_independent,
        is_rt_client=is_rt_client,
        spotify_url=spotify_url,
        image_url=image_url,
        related_ids=related_ids,
    )


async def enrich_related_artist(
    client: SpotifyClient,
    artist_id: str,
    all_node_ids: set[str],
) -> Optional[ArtistNode]:
    """Fetch + enrich a related artist that isn't already in our node set."""
    data = await client.get_artist(artist_id)
    if not data:
        return None

    spotify_name = data.get("name", "")
    followers = data.get("followers", {}).get("total", 0)
    genres = data.get("genres", [])
    images = data.get("images", [])
    spotify_url = data.get("external_urls", {}).get("spotify", "")
    image_url = pick_image(images)

    raw_label = await client.get_latest_album_label(artist_id)
    label, is_independent = classify_label(raw_label, spotify_name)

    await asyncio.sleep(REQUEST_DELAY)

    return ArtistNode(
        id=artist_id,
        name=spotify_name,
        followers=followers,
        genres=genres,
        label=label,
        is_independent=is_independent,
        is_rt_client=False,  # Related artists are opportunities by definition
        spotify_url=spotify_url,
        image_url=image_url,
        related_ids=[],  # Don't recurse into related's related
    )


# ---------------------------------------------------------------------------
# Graph builder
# ---------------------------------------------------------------------------

async def build_graph(client: SpotifyClient) -> EcosystemGraph:
    graph = EcosystemGraph()
    node_map: dict[str, ArtistNode] = {}  # spotify_id -> ArtistNode

    print(f"\nEnriching {len(RT_CLIENT_ARTISTS)} CRM artists …\n")
    total = len(RT_CLIENT_ARTISTS)

    # Enrich all RT client artists
    tasks = [
        enrich_artist(client, name, is_rt_client=True)
        for name in RT_CLIENT_ARTISTS
    ]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    for i, result in enumerate(results):
        name = RT_CLIENT_ARTISTS[i]
        if isinstance(result, Exception):
            print(f"  [error] {name}: {result}")
            continue
        if result is None:
            continue
        node_map[result.id] = result
        sys.stdout.write(f"\r  Processed {i+1}/{total} CRM artists …")
        sys.stdout.flush()

    print(f"\n  Done. Found {len(node_map)} artists on Spotify.")

    # Collect all related artist IDs not already in node_map
    related_ids_to_fetch: set[str] = set()
    for node in node_map.values():
        for rid in node.related_ids:
            if rid not in node_map:
                related_ids_to_fetch.add(rid)

    print(f"\nEnriching {len(related_ids_to_fetch)} related/opportunity artists …\n")

    related_tasks = [
        enrich_related_artist(client, rid, set(node_map.keys()))
        for rid in related_ids_to_fetch
    ]
    related_results = await asyncio.gather(*related_tasks, return_exceptions=True)

    for result in related_results:
        if isinstance(result, Exception) or result is None:
            continue
        node_map[result.id] = result

    # Build edges — only between nodes that exist in node_map
    edge_set: set[tuple[str, str]] = set()
    for node in node_map.values():
        for rid in node.related_ids:
            if rid in node_map:
                key = tuple(sorted([node.id, rid]))
                edge_set.add(key)  # type: ignore[arg-type]

    graph.nodes = list(node_map.values())
    graph.edges = [GraphEdge(source=s, target=t) for s, t in edge_set]

    print(f"\nGraph built: {len(graph.nodes)} nodes, {len(graph.edges)} edges.")
    return graph


# ---------------------------------------------------------------------------
# JSON serialization
# ---------------------------------------------------------------------------

def graph_to_dict(graph: EcosystemGraph) -> dict:
    return {
        "nodes": [asdict(n) for n in graph.nodes],
        "edges": [asdict(e) for e in graph.edges],
        "meta": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_nodes": len(graph.nodes),
            "total_edges": len(graph.edges),
            "rt_clients": sum(1 for n in graph.nodes if n.is_rt_client),
            "opportunities": sum(1 for n in graph.nodes if not n.is_rt_client),
        }
    }


# ---------------------------------------------------------------------------
# HTML / D3.js visualization
# ---------------------------------------------------------------------------

HTML_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>RT Artist Ecosystem Map</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow: hidden;
    height: 100vh;
    width: 100vw;
  }

  /* ── Top bar ── */
  #topbar {
    position: fixed;
    top: 0; left: 0; right: 0;
    height: 52px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 0 20px;
    z-index: 100;
  }
  #topbar h1 {
    font-size: 15px;
    font-weight: 600;
    color: #58a6ff;
    white-space: nowrap;
  }
  #topbar .meta {
    font-size: 12px;
    color: #8b949e;
    white-space: nowrap;
  }
  #search-input {
    flex: 1;
    max-width: 360px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6edf3;
    padding: 6px 12px;
    font-size: 13px;
    outline: none;
  }
  #search-input:focus { border-color: #58a6ff; }
  #search-input::placeholder { color: #484f58; }

  /* Filter pills */
  .filter-pills {
    display: flex;
    gap: 6px;
  }
  .pill {
    cursor: pointer;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    border: 1px solid transparent;
    transition: all 0.15s;
    user-select: none;
  }
  .pill-all   { background: #21262d; border-color: #30363d; color: #e6edf3; }
  .pill-rt    { background: rgba(88,166,255,0.1); border-color: #1f6feb; color: #58a6ff; }
  .pill-opps  { background: rgba(63,185,80,0.1); border-color: #238636; color: #3fb950; }
  .pill.active { box-shadow: 0 0 0 2px rgba(255,255,255,0.2); }

  /* ── Canvas ── */
  #graph-container {
    position: fixed;
    top: 52px; left: 0; right: 340px; bottom: 0;
  }
  svg { width: 100%; height: 100%; }

  /* Edges */
  .link {
    stroke: #30363d;
    stroke-width: 1.2;
    stroke-opacity: 0.55;
  }
  .link.highlighted { stroke: #f0b429; stroke-opacity: 1; stroke-width: 2; }

  /* Nodes */
  circle.node {
    stroke-width: 1.8;
    cursor: pointer;
    transition: stroke-width 0.1s, filter 0.1s;
  }
  circle.node:hover { stroke-width: 3; filter: brightness(1.3); }
  circle.node.rt-client { fill: #1f6feb; stroke: #58a6ff; }
  circle.node.opportunity { fill: #1a7f37; stroke: #3fb950; }
  circle.node.dimmed { opacity: 0.18; }
  circle.node.selected { stroke: #f0b429; stroke-width: 3; }

  /* Labels */
  text.node-label {
    fill: #e6edf3;
    font-size: 10px;
    pointer-events: none;
    text-anchor: middle;
    dominant-baseline: central;
    paint-order: stroke;
    stroke: #0d1117;
    stroke-width: 3px;
    stroke-linejoin: round;
  }

  /* ── Tooltip ── */
  #tooltip {
    position: fixed;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 12px;
    pointer-events: none;
    max-width: 220px;
    line-height: 1.6;
    z-index: 200;
    display: none;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }
  #tooltip strong { font-size: 13px; display: block; margin-bottom: 4px; }
  #tooltip .tag {
    display: inline-block;
    background: #21262d;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 10px;
    margin: 1px 2px 1px 0;
    color: #8b949e;
  }

  /* ── Sidebar ── */
  #sidebar {
    position: fixed;
    top: 52px; right: 0;
    width: 340px;
    bottom: 0;
    background: #161b22;
    border-left: 1px solid #30363d;
    overflow-y: auto;
    padding: 20px;
    z-index: 50;
  }
  #sidebar .placeholder {
    color: #484f58;
    font-size: 13px;
    text-align: center;
    margin-top: 60px;
  }
  #sidebar-content { display: none; }
  #sidebar-content h2 {
    font-size: 17px;
    font-weight: 600;
    margin-bottom: 4px;
    line-height: 1.3;
  }
  .badge {
    display: inline-block;
    border-radius: 20px;
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  .badge-rt   { background: #1f6feb; color: #fff; }
  .badge-opp  { background: #238636; color: #fff; }
  .badge-indep{ background: #6e4097; color: #fff; margin-left: 6px; }
  #sidebar-content .stat-row {
    display: flex;
    justify-content: space-between;
    padding: 6px 0;
    border-bottom: 1px solid #21262d;
    font-size: 13px;
  }
  #sidebar-content .stat-label { color: #8b949e; }
  #sidebar-content .stat-value { font-weight: 500; }
  #sidebar-content .genres-list {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 12px;
  }
  .genre-chip {
    background: #21262d;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    color: #8b949e;
  }
  #sidebar-content .related-section { margin-top: 18px; }
  #sidebar-content .related-section h3 {
    font-size: 12px;
    color: #8b949e;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .related-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 0;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.1s;
  }
  .related-item:hover { background: #21262d; padding-left: 6px; }
  .related-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .related-name { font-size: 13px; }
  #open-spotify {
    display: block;
    margin-top: 18px;
    padding: 8px 14px;
    background: #1db954;
    color: #000;
    font-weight: 600;
    font-size: 13px;
    border-radius: 6px;
    text-decoration: none;
    text-align: center;
    transition: background 0.15s;
  }
  #open-spotify:hover { background: #1ed760; }

  /* ── Legend ── */
  #legend {
    position: fixed;
    bottom: 20px;
    left: 20px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 12px;
    z-index: 100;
  }
  #legend .legend-title {
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 8px;
    font-weight: 600;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 5px;
  }
  .legend-dot {
    width: 12px; height: 12px;
    border-radius: 50%;
    border: 2px solid;
  }
  .legend-dot-rt   { background: #1f6feb; border-color: #58a6ff; }
  .legend-dot-opp  { background: #1a7f37; border-color: #3fb950; }

  /* ── Zoom controls ── */
  #zoom-controls {
    position: fixed;
    bottom: 20px;
    left: 180px;
    display: flex;
    flex-direction: column;
    gap: 4px;
    z-index: 100;
  }
  .zoom-btn {
    width: 32px; height: 32px;
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #e6edf3;
    font-size: 18px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    transition: background 0.1s;
  }
  .zoom-btn:hover { background: #21262d; }
</style>
</head>
<body>

<!-- Top bar -->
<div id="topbar">
  <h1>RT Artist Ecosystem</h1>
  <span class="meta" id="meta-text"></span>
  <input id="search-input" type="text" placeholder="Search artists …" />
  <div class="filter-pills">
    <span class="pill pill-all active" data-filter="all">All</span>
    <span class="pill pill-rt"  data-filter="rt">RT Clients</span>
    <span class="pill pill-opps" data-filter="opportunities">Opportunities</span>
  </div>
</div>

<div id="graph-container">
  <svg id="graph-svg"></svg>
</div>

<div id="tooltip"></div>

<!-- Sidebar -->
<div id="sidebar">
  <div class="placeholder" id="sidebar-placeholder">
    Click a node to see artist details
  </div>
  <div id="sidebar-content">
    <h2 id="sb-name"></h2>
    <div>
      <span class="badge" id="sb-type-badge"></span>
      <span class="badge badge-indep" id="sb-indep-badge" style="display:none">Independent</span>
    </div>
    <div id="sb-stats"></div>
    <div id="sb-genres" class="genres-list"></div>
    <div class="related-section">
      <h3>Connected Artists</h3>
      <div id="sb-related"></div>
    </div>
    <a id="open-spotify" href="#" target="_blank" rel="noopener">Open on Spotify</a>
  </div>
</div>

<!-- Legend -->
<div id="legend">
  <div class="legend-title">Legend</div>
  <div class="legend-item">
    <div class="legend-dot legend-dot-rt"></div>
    <span>RT Client</span>
  </div>
  <div class="legend-item">
    <div class="legend-dot legend-dot-opp"></div>
    <span>Opportunity</span>
  </div>
  <div class="legend-item" style="margin-top:6px; color:#8b949e; font-size:11px;">
    Node size = follower count
  </div>
</div>

<!-- Zoom controls -->
<div id="zoom-controls">
  <button class="zoom-btn" id="zoom-in">+</button>
  <button class="zoom-btn" id="zoom-reset" style="font-size:12px;">⊙</button>
  <button class="zoom-btn" id="zoom-out">−</button>
</div>

<script>
// ── Embedded graph data ──────────────────────────────────────────────────
const GRAPH_DATA = __GRAPH_DATA__;

// ── Helpers ──────────────────────────────────────────────────────────────
function formatFollowers(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function nodeRadius(followers) {
  const minR = 5, maxR = 38;
  if (!followers) return minR;
  // Log scale so huge artists don't dwarf everyone else
  const logMax = Math.log1p(20_000_000);
  const r = minR + (maxR - minR) * Math.log1p(followers) / logMax;
  return Math.min(maxR, Math.max(minR, r));
}

// Build lookup maps
const nodeById = {};
GRAPH_DATA.nodes.forEach(n => { nodeById[n.id] = n; });

// Adjacency for highlight
const adjSet = new Set();
GRAPH_DATA.edges.forEach(e => {
  adjSet.add(e.source + '|' + e.target);
  adjSet.add(e.target + '|' + e.source);
});
function areAdjacent(a, b) { return adjSet.has(a + '|' + b); }

// ── D3 setup ─────────────────────────────────────────────────────────────
const container = document.getElementById('graph-container');
const svg = d3.select('#graph-svg');
const tooltip = document.getElementById('tooltip');

let width = container.clientWidth;
let height = container.clientHeight;

const g = svg.append('g').attr('class', 'main-g');

// Zoom behavior
const zoom = d3.zoom()
  .scaleExtent([0.1, 6])
  .on('zoom', (event) => {
    g.attr('transform', event.transform);
  });
svg.call(zoom);

// ── Simulation ────────────────────────────────────────────────────────────
const nodes = GRAPH_DATA.nodes.map(d => ({ ...d }));
const edges = GRAPH_DATA.edges.map(d => ({ ...d }));

// Map edge source/target strings to node objects
const nodeMap = new Map(nodes.map(n => [n.id, n]));
edges.forEach(e => {
  e.source = nodeMap.get(e.source) || e.source;
  e.target = nodeMap.get(e.target) || e.target;
});

const simulation = d3.forceSimulation(nodes)
  .force('link', d3.forceLink(edges).id(d => d.id).distance(d => {
    const bothRT = d.source.is_rt_client && d.target.is_rt_client;
    return bothRT ? 80 : 120;
  }).strength(0.4))
  .force('charge', d3.forceManyBody().strength(d => -120 - nodeRadius(d.followers) * 3))
  .force('center', d3.forceCenter(width / 2, height / 2))
  .force('collision', d3.forceCollide().radius(d => nodeRadius(d.followers) + 6))
  .alphaDecay(0.025)
  .velocityDecay(0.35);

// ── Render edges ──────────────────────────────────────────────────────────
const linkSelection = g.append('g').attr('class', 'links')
  .selectAll('line.link')
  .data(edges)
  .join('line')
  .attr('class', 'link');

// ── Render nodes ──────────────────────────────────────────────────────────
const nodeGroup = g.append('g').attr('class', 'nodes')
  .selectAll('g.node-group')
  .data(nodes)
  .join('g')
  .attr('class', 'node-group')
  .call(d3.drag()
    .on('start', dragStarted)
    .on('drag',  dragged)
    .on('end',   dragEnded));

nodeGroup.append('circle')
  .attr('class', d => 'node ' + (d.is_rt_client ? 'rt-client' : 'opportunity'))
  .attr('r', d => nodeRadius(d.followers));

// Labels only for nodes with enough followers or all RT clients
nodeGroup.append('text')
  .attr('class', 'node-label')
  .attr('dy', d => nodeRadius(d.followers) + 12)
  .text(d => {
    const r = nodeRadius(d.followers);
    if (d.is_rt_client || r > 14) return d.name;
    return '';
  });

// ── Tooltip + hover ───────────────────────────────────────────────────────
nodeGroup
  .on('mousemove', (event, d) => {
    const genres = d.genres.slice(0, 3).map(g => `<span class="tag">${g}</span>`).join('');
    tooltip.innerHTML = `
      <strong>${d.name}</strong>
      ${d.followers ? `<div>${formatFollowers(d.followers)} followers</div>` : ''}
      ${d.label !== 'Unknown' ? `<div style="color:#8b949e;font-size:11px;">${d.label}${d.is_independent ? ' (indie)' : ''}</div>` : ''}
      ${genres ? `<div style="margin-top:4px">${genres}</div>` : ''}
    `;
    tooltip.style.display = 'block';
    tooltip.style.left = (event.clientX + 14) + 'px';
    tooltip.style.top  = (event.clientY - 10) + 'px';
  })
  .on('mouseleave', () => { tooltip.style.display = 'none'; });

// ── Click → sidebar ───────────────────────────────────────────────────────
let selectedId = null;

nodeGroup.on('click', (event, d) => {
  event.stopPropagation();
  selectNode(d);
});

svg.on('click', () => {
  selectedId = null;
  clearHighlight();
  hideSidebar();
});

function selectNode(d) {
  selectedId = d.id;
  highlightNeighbors(d);
  populateSidebar(d);
}

function highlightNeighbors(d) {
  const connectedIds = new Set([d.id]);
  edges.forEach(e => {
    const sid = e.source.id || e.source;
    const tid = e.target.id || e.target;
    if (sid === d.id) connectedIds.add(tid);
    if (tid === d.id) connectedIds.add(sid);
  });

  nodeGroup.selectAll('circle.node')
    .classed('dimmed', n => !connectedIds.has(n.id))
    .classed('selected', n => n.id === d.id);

  linkSelection
    .classed('highlighted', e => {
      const sid = e.source.id || e.source;
      const tid = e.target.id || e.target;
      return sid === d.id || tid === d.id;
    });
}

function clearHighlight() {
  nodeGroup.selectAll('circle.node').classed('dimmed', false).classed('selected', false);
  linkSelection.classed('highlighted', false);
}

// ── Sidebar population ────────────────────────────────────────────────────
function populateSidebar(d) {
  document.getElementById('sidebar-placeholder').style.display = 'none';
  const sc = document.getElementById('sidebar-content');
  sc.style.display = 'block';

  document.getElementById('sb-name').textContent = d.name;

  const badge = document.getElementById('sb-type-badge');
  badge.textContent = d.is_rt_client ? 'RT Client' : 'Opportunity';
  badge.className = 'badge ' + (d.is_rt_client ? 'badge-rt' : 'badge-opp');

  const indepBadge = document.getElementById('sb-indep-badge');
  indepBadge.style.display = d.is_independent ? 'inline-block' : 'none';

  // Stats
  const stats = document.getElementById('sb-stats');
  stats.innerHTML = `
    <div class="stat-row">
      <span class="stat-label">Followers</span>
      <span class="stat-value">${formatFollowers(d.followers)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Label</span>
      <span class="stat-value">${d.label || 'Unknown'}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Status</span>
      <span class="stat-value">${d.is_independent ? 'Independent' : 'Signed'}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Connections</span>
      <span class="stat-value">${d.related_ids ? d.related_ids.length : 0}</span>
    </div>
  `;

  // Genres
  const genresEl = document.getElementById('sb-genres');
  genresEl.innerHTML = d.genres.map(g => `<span class="genre-chip">${g}</span>`).join('');

  // Related artists (those present in our graph)
  const relatedEl = document.getElementById('sb-related');
  const relatedNodes = (d.related_ids || [])
    .map(id => nodeById[id])
    .filter(Boolean)
    .slice(0, 10);

  relatedEl.innerHTML = relatedNodes.length
    ? relatedNodes.map(r => `
        <div class="related-item" data-id="${r.id}">
          <div class="related-dot" style="background:${r.is_rt_client ? '#1f6feb' : '#1a7f37'}; border:2px solid ${r.is_rt_client ? '#58a6ff' : '#3fb950'};"></div>
          <span class="related-name">${r.name}</span>
        </div>
      `).join('')
    : '<span style="color:#484f58;font-size:12px;">No connected artists in graph</span>';

  // Click related item to navigate
  relatedEl.querySelectorAll('.related-item').forEach(el => {
    el.addEventListener('click', () => {
      const node = nodeById[el.dataset.id];
      if (node) {
        const simNode = nodes.find(n => n.id === node.id);
        if (simNode) selectNode(simNode);
      }
    });
  });

  // Spotify link
  document.getElementById('open-spotify').href = d.spotify_url || '#';
}

function hideSidebar() {
  document.getElementById('sidebar-placeholder').style.display = 'block';
  document.getElementById('sidebar-content').style.display = 'none';
}

// ── Tick ──────────────────────────────────────────────────────────────────
simulation.on('tick', () => {
  linkSelection
    .attr('x1', d => d.source.x)
    .attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x)
    .attr('y2', d => d.target.y);

  nodeGroup.attr('transform', d => `translate(${d.x},${d.y})`);
});

// ── Drag ──────────────────────────────────────────────────────────────────
function dragStarted(event, d) {
  if (!event.active) simulation.alphaTarget(0.3).restart();
  d.fx = d.x; d.fy = d.y;
}
function dragged(event, d) { d.fx = event.x; d.fy = event.y; }
function dragEnded(event, d) {
  if (!event.active) simulation.alphaTarget(0);
  d.fx = null; d.fy = null;
}

// ── Search / Filter ───────────────────────────────────────────────────────
let activeFilter = 'all';
let searchTerm = '';

function applyFilters() {
  nodeGroup.selectAll('circle.node').classed('dimmed', d => {
    const matchesFilter =
      activeFilter === 'all' ||
      (activeFilter === 'rt' && d.is_rt_client) ||
      (activeFilter === 'opportunities' && !d.is_rt_client);

    const matchesSearch = !searchTerm ||
      d.name.toLowerCase().includes(searchTerm) ||
      (d.genres || []).some(g => g.toLowerCase().includes(searchTerm)) ||
      (d.label || '').toLowerCase().includes(searchTerm);

    return !(matchesFilter && matchesSearch);
  });
}

document.getElementById('search-input').addEventListener('input', e => {
  searchTerm = e.target.value.toLowerCase().trim();
  applyFilters();
});

document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    activeFilter = pill.dataset.filter;
    applyFilters();
  });
});

// ── Zoom controls ─────────────────────────────────────────────────────────
document.getElementById('zoom-in').addEventListener('click', () => {
  svg.transition().duration(300).call(zoom.scaleBy, 1.4);
});
document.getElementById('zoom-out').addEventListener('click', () => {
  svg.transition().duration(300).call(zoom.scaleBy, 0.7);
});
document.getElementById('zoom-reset').addEventListener('click', () => {
  svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity.translate(width / 2, height / 2).scale(0.8).translate(-width / 2, -height / 2));
});

// ── Meta text ─────────────────────────────────────────────────────────────
const meta = GRAPH_DATA.meta || {};
document.getElementById('meta-text').textContent =
  `${meta.total_nodes || nodes.length} artists · ${meta.rt_clients || 0} RT clients · ${meta.opportunities || 0} opportunities`;

// ── Resize ────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  width  = container.clientWidth;
  height = container.clientHeight;
  simulation.force('center', d3.forceCenter(width / 2, height / 2));
  simulation.alpha(0.1).restart();
});
</script>
</body>
</html>
"""


def build_html(graph_dict: dict) -> str:
    graph_json = json.dumps(graph_dict, separators=(",", ":"))
    return HTML_TEMPLATE.replace("__GRAPH_DATA__", graph_json)


# ---------------------------------------------------------------------------
# Spotify OAuth — client credentials
# ---------------------------------------------------------------------------

async def get_spotify_token(session: aiohttp.ClientSession) -> str:
    import base64
    credentials = base64.b64encode(
        f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode()
    ).decode()
    async with session.post(
        SPOTIFY_TOKEN_URL,
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={"grant_type": "client_credentials"},
        timeout=aiohttp.ClientTimeout(total=15),
    ) as resp:
        if resp.status != 200:
            body = await resp.text()
            sys.exit(f"Spotify auth failed ({resp.status}): {body}")
        data = await resp.json()
        return data["access_token"]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main() -> None:
    print("=" * 60)
    print("RT Artist Ecosystem Map Builder")
    print("=" * 60)
    print(f"Output directory: {OUTPUT_DIR}\n")

    connector = aiohttp.TCPConnector(limit=MAX_CONCURRENT + 4, ssl=False)
    async with aiohttp.ClientSession(connector=connector) as session:
        print("Authenticating with Spotify …")
        token = await get_spotify_token(session)
        print("  Token acquired.\n")

        client = SpotifyClient(session, token)
        graph = await build_graph(client)

    # Serialize
    graph_dict = graph_to_dict(graph)

    json_path = JSON_OUTPUT
    html_path = HTML_OUTPUT

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(graph_dict, f, indent=2, ensure_ascii=False)
    print(f"\nJSON saved: {json_path}")

    html = build_html(graph_dict)
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"HTML saved: {html_path}")

    meta = graph_dict["meta"]
    print(f"\nSummary:")
    print(f"  Total nodes : {meta['total_nodes']}")
    print(f"  RT clients  : {meta['rt_clients']}")
    print(f"  Opportunities: {meta['opportunities']}")
    print(f"  Edges        : {meta['total_edges']}")
    print(f"\nOpen the HTML file in your browser to explore the graph.")
    print(f"  open \"{html_path}\"")


if __name__ == "__main__":
    asyncio.run(main())

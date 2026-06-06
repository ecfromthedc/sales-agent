#!/usr/bin/env python3
"""Chartmetric gap crawler.

Engine: for every active CLIENT artist (anchor), pull Chartmetric `relatedartists`.
Artists that show up as peers of MANY of our clients are, by definition, sitting
in RT's exact lane. Subtract anyone already in the CRM -> those are the gaps.

Then enrich each candidate with metadata (monthly listeners, label, career stage,
trend, contacts) and latest/upcoming release (timing) so we can score + time outreach.

Resumable: caches token, id-resolution, related-lists, and enrichment to disk.
Run: nohup python3 02_crawl.py > out/crawl.log 2>&1 &
"""
import json, os, re, time, urllib.request, urllib.parse, urllib.error

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")
CACHE = os.path.join(OUT, "cache")
os.makedirs(CACHE, exist_ok=True)
REFRESH_TOKEN = open(os.path.join(HERE, "../../.secrets/chartmetric_refresh_token")).read().strip()

SLEEP = 0.34
_token = {"v": None, "exp": 0}


def now():
    return time.time()


def get_token():
    if _token["v"] and now() < _token["exp"]:
        return _token["v"]
    req = urllib.request.Request(
        "https://api.chartmetric.com/api/token",
        data=json.dumps({"refreshtoken": REFRESH_TOKEN}).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.loads(r.read())
    _token["v"] = d["token"]
    _token["exp"] = now() + d.get("expires_in", 3600) - 120
    return _token["v"]


def cm_get(path, tries=4):
    url = f"https://api.chartmetric.com/api/{path}"
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {get_token()}"})
            with urllib.request.urlopen(req, timeout=30) as r:
                time.sleep(SLEEP)
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 + i * 3); continue
            if e.code in (401, 403):
                _token["exp"] = 0; time.sleep(1); continue
            if e.code == 402:
                # Out of API credits — stop hard, do NOT retry or poison cache.
                raise SystemExit("CHARTMETRIC_OUT_OF_CREDITS: top up the account, then resume.")
            if e.code == 404:
                return None
            time.sleep(1 + i)
        except Exception:
            time.sleep(1 + i)
    return None


def cache_read(name):
    p = os.path.join(CACHE, name)
    if os.path.exists(p):
        return json.load(open(p))
    return None


def cache_write(name, obj):
    json.dump(obj, open(os.path.join(CACHE, name), "w"))


def norm(s):
    s = (s or "").lower().strip()
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r"\bfeat\b.*|\bft\b.*|&.*", "", s)  # drop collab tails
    s = re.sub(r"[^a-z0-9 ]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def resolve_id(name):
    key = "id_" + re.sub(r"[^a-z0-9]", "_", name.lower())[:60] + ".json"
    c = cache_read(key)
    if c is not None:
        return c
    q = urllib.parse.quote(name)
    d = cm_get(f"search?q={q}&type=artists&limit=5")
    res = None
    if d:
        arr = (d.get("obj") or {}).get("artists") or []
        target = norm(name)
        best = None
        for a in arr:
            score = (a.get("cm_artist_score") or 0) + (1 if norm(a.get("name", "")) == target else 0) * 1000
            score += (a.get("sp_followers") or 0) / 1e7
            if best is None or score > best[0]:
                best = (score, a)
        if best:
            a = best[1]
            res = {"id": a["id"], "name": a["name"],
                   "sp_followers": a.get("sp_followers"),
                   "sp_monthly_listeners": a.get("sp_monthly_listeners"),
                   "cm_artist_score": a.get("cm_artist_score")}
    cache_write(key, res)
    return res


def related(cm_id):
    key = f"rel_{cm_id}.json"
    c = cache_read(key)
    if c is not None:
        return c
    d = cm_get(f"artist/{cm_id}/relatedartists?limit=25")
    arr = d.get("obj") if isinstance(d, dict) else d
    if not isinstance(arr, list):
        return []  # transient failure — do NOT cache, so resume retries it
    cache_write(key, arr)
    return arr


def enrich(cm_id):
    key = f"meta_{cm_id}.json"
    c = cache_read(key)
    if c is not None:
        return c
    d = cm_get(f"artist/{cm_id}")
    o = (d or {}).get("obj") or {}
    st = o.get("cm_statistics") or {}
    cs = o.get("career_status") or {}
    genres = o.get("genres") or {}
    prim = (genres.get("primary") or {}).get("name") if isinstance(genres, dict) else None
    sec = [g.get("name") for g in (genres.get("secondary") or [])] if isinstance(genres, dict) else []
    meta = {
        "id": cm_id,
        "name": o.get("name"),
        "record_label": o.get("record_label"),
        "booking_agent": o.get("booking_agent"),
        "press_contact": o.get("press_contact"),
        "general_manager": o.get("general_manager"),
        "cm_artist_score": o.get("cm_artist_score"),
        "cm_artist_rank": o.get("cm_artist_rank"),
        "sp_monthly_listeners": st.get("sp_monthly_listeners"),
        "sp_followers": st.get("sp_followers"),
        "ins_followers": st.get("ins_followers"),
        "ycs_subscribers": st.get("ycs_subscribers"),
        "career_stage": cs.get("stage"),
        "career_trend": cs.get("trend"),
        "primary_genre": prim,
        "secondary_genres": sec,
        "hometown": o.get("hometown_city"),
        "current_city": o.get("current_city"),
    }
    # latest releases (timing + release label)
    al = cm_get(f"artist/{cm_id}/albums?limit=6")
    arr = (al or {}).get("obj") if isinstance(al, dict) else al
    rels = []
    if isinstance(arr, list):
        for a in arr[:6]:
            rels.append({"name": a.get("name"), "release_date": a.get("release_date"),
                         "label": a.get("label")})
    meta["releases"] = rels
    cache_write(key, meta)
    return meta


def main():
    crm = json.load(open(os.path.join(OUT, "crm_rows.json")))
    anchors_raw = crm["client_artists"]
    crm_norm = {norm(a) for a in crm["all_crm_artists"] if norm(a)}

    # de-dupe anchors by normalized name
    seen = set(); anchors = []
    for a in anchors_raw:
        n = norm(a)
        if n and n not in seen:
            seen.add(n); anchors.append(a)
    print(f"[crawl] anchors to resolve: {len(anchors)} | CRM exclusion set: {len(crm_norm)}", flush=True)

    # Stage 1: resolve anchor ids
    anchor_ids = {}
    crm_cm_ids = set()
    for i, a in enumerate(anchors):
        r = resolve_id(a)
        if r:
            anchor_ids[a] = r["id"]
            crm_cm_ids.add(r["id"])
        if i % 25 == 0:
            print(f"[resolve] {i}/{len(anchors)}", flush=True)
    # NOTE: we intentionally do NOT resolve every CRM artist to a cm id here —
    # that doubled credit burn. Exclusion is handled by (a) anchor cm ids and
    # (b) normalized-name match against crm_norm in the aggregation stage.
    cache_write("../anchor_ids.json", anchor_ids)
    print(f"[crawl] resolved {len(anchor_ids)} anchor ids; total CRM cm ids: {len(crm_cm_ids)}", flush=True)

    # Stage 2: peer aggregation
    cand = {}  # cm_id -> {name, peer_count, anchors[], cm_artist_score, sp_followers}
    for i, (a, cid) in enumerate(anchor_ids.items()):
        for p in related(cid):
            pid = p.get("id")
            if pid is None or pid in crm_cm_ids:
                continue
            if norm(p.get("name", "")) in crm_norm:
                continue
            e = cand.setdefault(pid, {"id": pid, "name": p.get("name"), "peer_count": 0,
                                      "anchors": [], "cm_artist_score": p.get("cm_artist_score"),
                                      "sp_followers": p.get("sp_followers"),
                                      "popularity": p.get("popularity")})
            e["peer_count"] += 1
            if len(e["anchors"]) < 12:
                e["anchors"].append(a)
        if i % 25 == 0:
            print(f"[related] {i}/{len(anchor_ids)} | candidates so far: {len(cand)}", flush=True)
    cache_write("../candidates_raw.json", cand)
    print(f"[crawl] raw candidates (not in CRM): {len(cand)}", flush=True)

    # Stage 3: enrich top candidates by peer_count then cm score
    ranked = sorted(cand.values(),
                    key=lambda c: (c["peer_count"], c.get("cm_artist_score") or 0), reverse=True)
    TOP = int(os.environ.get("ENRICH_TOP", "260"))
    enriched = []
    for i, c in enumerate(ranked[:TOP]):
        m = enrich(c["id"])
        m["peer_count"] = c["peer_count"]
        m["peer_anchors"] = c["anchors"]
        enriched.append(m)
        if i % 20 == 0:
            print(f"[enrich] {i}/{min(TOP,len(ranked))}", flush=True)
    json.dump(enriched, open(os.path.join(OUT, "candidates_enriched.json"), "w"), indent=2)
    print(f"[crawl] DONE. enriched {len(enriched)} candidates -> out/candidates_enriched.json", flush=True)


if __name__ == "__main__":
    main()

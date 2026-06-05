#!/usr/bin/env python3
"""Score gap candidates against the RT targeting rubric, and roll up the
label / management-company gaps. Consumes candidates_enriched.json + crm_rows.json.

Key filters:
  - HARD sweet-spot gate: only 8K-600K Spotify monthly listeners qualify as leads
    (below = no budget; above = has in-house team). Profile §2.
  - Compilation/playlist filter: ignore "releases" that are DJ mixes, live comps,
    Apple Music sessions, or have no real label (these pollute timing).
  - Imprint-aware labels: use the real release imprint, not the major distro backend.

Outputs:
  out/scored_targets.json   - every candidate scored, with qualified flag + reason
  out/label_gaps.json       - real indie labels/mgmt in our lane we don't work, ranked
"""
import json, os, re, datetime

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")
TODAY = datetime.date(2026, 6, 5)

SWEET_MIN, SWEET_MAX = 8000, 600000

DISTRIBUTORS = {"distrokid", "distro kid", "tunecore", "cd baby", "cdbaby", "united masters",
                "unitedmasters", "symphonic", "stem", "believe", "gyrostream", "awal", "ditto",
                "amuse", "too lost", "toolost", "soundon", "broke", "vydia", "the orchard",
                "orchard", "venice", "n/a", "na", "independent", "independent co", "self released",
                "self-released", "unknown", "ingrooves", "fuga", "kontor new media"}

# Major-family + distro-backend aliases. Maps to the parent we ALREADY serve, so we
# never (a) re-list a major as a gap or (b) miscount an artist as independent.
MAJOR_ALIASES = {
    "warner": "Warner", "warner records": "Warner", "wmg": "Warner", "wea": "Warner",
    "atlantic": "Warner", "elektra": "Warner", "300 entertainment": "Warner", "300": "Warner",
    "asylum": "Warner", "warner records nashville": "Warner", "rhino": "Warner",
    "columbia": "Sony", "rca": "Sony", "epic": "Sony", "sony": "Sony", "sme": "Sony",
    "arista": "Sony", "rca records": "Sony", "the orchard": "Sony",
    "universal": "UMG", "umg": "UMG", "republic": "UMG", "interscope": "UMG", "ume": "UMG",
    "capitol": "UMG", "island": "UMG", "def jam": "UMG", "geffen": "UMG", "plg": "UMG",
    "polydor": "UMG", "emi": "UMG", "virgin music group": "UMG", "virgin music": "UMG",
    "darkroom/interscope records": "UMG", "darkroom": "UMG", "pgd": "UMG", "mercury": "UMG",
    "empire": "Empire", "nettwerk": "Nettwerk", "nettwerk music group": "Nettwerk",
    "insomniac": "Insomniac", "insomniac music group": "Insomniac", "mau5trap": "Insomniac",
    "big loud": "Big Loud", "mega house": "Mega House", "mega house recordings": "Mega House",
    "bmg": "BMG",
}
SERVED = {"Warner", "Sony", "UMG", "Empire", "Nettwerk", "Insomniac", "Big Loud", "Mega House", "BMG"}

# Substring major-detection — catches messy distribution backends like "Warner X5",
# "UME Global Clearing", "PLG Capitol", "222/Interscope", "Night Street/Warner".
MAJOR_SUBSTR = [
    (("warner", "atlantic", "elektra", "asylum", "rhino", "warner x", "300 entertainment"), "Warner"),
    (("universal", "umg", "ume ", "ume global", "interscope", "capitol", "republic", "island",
      "def jam", "geffen", "polydor", "virgin", "motown", "verve", "mercury", "plg", "darkroom"), "UMG"),
    (("sony", "columbia", "rca", "epic", "arista", "legacy", "the orchard", "sme"), "Sony"),
    (("nettwerk",), "Nettwerk"), (("empire",), "Empire"),
    (("insomniac", "mau5trap"), "Insomniac"), (("big loud",), "Big Loud"),
]

COMPILATION_RE = re.compile(
    r"\b(dj mix|mixtape mix|apple music|live from|live at|on the radar|fetenhits|"
    r"afterwork|open air|various|compilation|now that|hits|greatest hits|"
    r"workout|party mix|summer mix|winter mix|christmas|karaoke|tribute|\bvol\.?\s*\d|"
    r"the essential|playlist|sessions vol|requiem|wedding 20|wm 20|uv \d|"
    r"summer songs|beach party|fu(ss|ß)ball|f(u|ü)r |afterwork|spoty|festival hits|"
    r"running mix|gym|sleep|focus|study|chill mix|love songs|pool party)\b", re.I)
YEAR_ONLY_RE = re.compile(r"^\s*(wm\s*)?20\d\d\s*$|\b20\d\d\b.*\bmix\b", re.I)


def norm_label(s):
    s = (s or "").lower().strip()
    s = re.sub(r"\(.*?\)", "", s)
    s = re.sub(r"[^a-z0-9 /&]", "", s).strip()
    return re.sub(r"\s+", " ", s)


def canonical(s):
    n = norm_label(s)
    if not n:
        return ""
    if n in MAJOR_ALIASES:
        return MAJOR_ALIASES[n]
    # token-level major detection (handles "darkroom/interscope", "x / rca")
    for token in re.split(r"[/&]", n):
        token = token.strip()
        if token in MAJOR_ALIASES:
            return MAJOR_ALIASES[token]
    base = re.sub(r"\b(records|record|music|group|entertainment|ent|recordings|co|llc|inc|the|nashville)\b",
                  "", n).strip()
    base = re.sub(r"\s+", " ", base)
    if base in MAJOR_ALIASES:          # re-check stripped base (e.g. "Island Records" -> "island" -> UMG)
        return MAJOR_ALIASES[base]
    for subs, parent in MAJOR_SUBSTR:  # messy backends: "warner x5", "ume global clearing"
        if any(sub in n for sub in subs):
            return parent
    return base or n


def is_distributor(s):
    n = norm_label(s)
    return n in DISTRIBUTORS or canonical(s) in DISTRIBUTORS or not n


def days_until(date_str):
    try:
        return (datetime.date.fromisoformat((date_str or "")[:10]) - TODAY).days
    except Exception:
        return None


def clean_releases(rels):
    """Keep only the artist's own real singles/albums; drop comps & label-less junk; dedup."""
    seen = set()
    out = []
    for r in rels:
        nm = (r.get("name") or "").strip()
        lbl = (r.get("label") or "").strip()
        if not nm or not lbl:           # label-less = playlist/aggregator junk
            continue
        if COMPILATION_RE.search(nm) or YEAR_ONLY_RE.search(nm):
            continue
        base = re.sub(r"\s*-\s*single$|\s*-\s*ep$", "", nm, flags=re.I).strip().lower()
        key = (base, (r.get("release_date") or "")[:10])
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def genre_fit(meta):
    g = " ".join([str(meta.get("primary_genre") or "")] +
                 [str(x) for x in (meta.get("secondary_genres") or [])]).lower()
    if any(k in g for k in ["hip hop", "rap", "r&b", "rnb", "pop", "afro", "latin",
                            "house", "edm", "electronic", "dance"]):
        return 100, g
    if any(k in g for k in ["indie", "folk", "alternative", "singer", "country"]):
        return 75, g
    return (50, g) if g.strip() else (25, g)


def best_imprint(m):
    """Real relationship target: prefer the release imprint over the major backend."""
    rec = m.get("record_label")
    if rec and canonical(rec) not in SERVED and not is_distributor(rec):
        return rec
    for r in clean_releases(m.get("releases", [])):
        lbl = r.get("label")
        if lbl and canonical(lbl) not in SERVED and not is_distributor(lbl):
            return lbl
    return rec


def score_candidate(m, worked_canon):
    ml = m.get("sp_monthly_listeners") or 0
    rels = clean_releases(m.get("releases", []))

    # Timing from clean releases only
    upcoming = sorted([(days_until(r["release_date"]), r) for r in rels
                       if days_until(r.get("release_date")) is not None and days_until(r["release_date"]) >= 0],
                      key=lambda x: x[0])
    recent = sorted([(days_until(r["release_date"]), r) for r in rels
                     if days_until(r.get("release_date")) is not None and days_until(r["release_date"]) < 0],
                    key=lambda x: x[0], reverse=True)
    timing_pts, timing_note, window = 0, "no release on horizon", None
    if upcoming:
        du, r = upcoming[0]; window = r["release_date"]
        if du <= 7:    timing_pts, timing_note = 100, f"OWN release in {du}d ({r['name']}) — launch window NOW"
        elif du <= 28: timing_pts, timing_note = 90, f"OWN release in {du}d ({r['name']}) — PRIME pre-release outreach"
        elif du <= 60: timing_pts, timing_note = 55, f"release in {du}d ({r['name']})"
        else:          timing_pts, timing_note = 25, f"release {du}d out ({r['name']})"
    elif recent:
        du, r = recent[0]; window = r["release_date"]
        if du >= -21:  timing_pts, timing_note = 80, f"released {abs(du)}d ago ({r['name']}) — push window open"
        elif du >= -60: timing_pts, timing_note = 45, f"released {abs(du)}d ago ({r['name']})"
        else:          timing_pts, timing_note = 15, f"last release {abs(du)}d ago"

    # HARD sweet-spot gate
    qualified, dq = True, None
    if ml < SWEET_MIN:
        qualified, dq = False, f"below sweet spot ({ml:,} ML < {SWEET_MIN:,})"
    elif ml > SWEET_MAX:
        qualified, dq = False, f"above sweet spot ({ml:,} ML > {SWEET_MAX:,}) — likely in-house team"

    if ml < 50000:    tier_pts = 60
    elif ml < 200000: tier_pts = 100
    elif ml <= 600000: tier_pts = 95
    else:             tier_pts = 20

    g_pts, gstr = genre_fit(m)

    imprint = best_imprint(m)
    lc = canonical(imprint)
    distro = is_distributor(imprint)
    if distro:
        rel_pts, budget_pts = 10, 30
    elif lc in worked_canon or lc in SERVED:
        rel_pts, budget_pts = 75, 90      # unworked artist at a label we already serve = WARM intro
    elif lc in {"Warner", "Sony", "UMG", "Empire"}:
        rel_pts, budget_pts = 25, 100
    else:
        rel_pts, budget_pts = 30, 65      # indie/mgmt, new relationship, real budget

    trend = (m.get("career_trend") or "").lower()
    stage = (m.get("career_stage") or "").lower()
    momentum = 0
    if any(k in trend for k in ["up", "rising", "gradual incline"]): momentum += 10
    if stage in ("mid_level", "developing", "mainstream"): momentum += 5

    score = (rel_pts*0.30 + timing_pts*0.25 + g_pts*0.15 + tier_pts*0.15 + budget_pts*0.15) + momentum
    score = round(min(100, score), 1)
    if not qualified:
        score = round(score * 0.45, 1)    # keep visible but demote

    camp = "Sound Campaign ($1.5K+)" if ml < 150000 else "Full Campaign ($5K-$15K)"

    return {
        "name": m.get("name"), "cm_id": m.get("id"), "score": score,
        "qualified": qualified, "disqualified_reason": dq,
        "monthly_listeners": ml, "sp_followers": m.get("sp_followers"),
        "ins_followers": m.get("ins_followers"), "cm_artist_score": m.get("cm_artist_score"),
        "primary_genre": m.get("primary_genre"), "genre_str": gstr,
        "record_label": m.get("record_label"), "imprint": imprint, "label_canonical": lc,
        "is_distributor_only": distro,
        "label_already_worked": (lc in worked_canon or lc in SERVED),
        "career_stage": m.get("career_stage"), "career_trend": m.get("career_trend"),
        "booking_agent": m.get("booking_agent"), "press_contact": m.get("press_contact"),
        "general_manager": m.get("general_manager"),
        "peer_count": m.get("peer_count"), "peer_anchors": m.get("peer_anchors"),
        "timing_note": timing_note, "release_window": window, "campaign_fit": camp,
        "hometown": m.get("hometown"), "clean_releases": rels[:5],
    }


def main():
    crm = json.load(open(os.path.join(OUT, "crm_rows.json")))
    worked_canon = {canonical(l) for l in crm["all_worked_labels"] if not is_distributor(l)}
    worked_canon.discard("")
    cands = json.load(open(os.path.join(OUT, "candidates_enriched.json")))

    scored = [score_candidate(m, worked_canon) for m in cands]
    scored.sort(key=lambda x: (x["score"], x["peer_count"] or 0), reverse=True)
    json.dump(scored, open(os.path.join(OUT, "scored_targets.json"), "w"), indent=2)

    q = [s for s in scored if s["qualified"]]

    def is_self_release(s):
        a = re.sub(r"[^a-z0-9]", "", (s["name"] or "").lower())
        l = re.sub(r"[^a-z0-9]", "", (s["imprint"] or "").lower())
        return a and l and (a in l or l in a)

    # tag self-releasing artists (gap is the artist/manager, not a label)
    for s in scored:
        s["self_released"] = is_self_release(s)

    # Label / management gap rollup — qualified sweet-spot artists, real imprints only
    labels = {}
    for s in q:
        lc = s["label_canonical"]
        if not lc or s["is_distributor_only"] or lc in SERVED or s["label_already_worked"]:
            continue
        if is_self_release(s):
            continue
        e = labels.setdefault(lc, {"label": s["imprint"], "canonical": lc, "n_artists": 0,
                                   "total_ml": 0, "artists": [], "best_score": 0, "soonest_release": None})
        e["n_artists"] += 1
        e["total_ml"] += s["monthly_listeners"] or 0
        e["best_score"] = max(e["best_score"], s["score"])
        if len(e["artists"]) < 10:
            e["artists"].append({"name": s["name"], "ml": s["monthly_listeners"],
                                 "score": s["score"], "window": s["release_window"]})
        w = s["release_window"]
        if w and (days_until(w) or -999) >= 0 and (e["soonest_release"] is None or w < e["soonest_release"]):
            e["soonest_release"] = w
    label_list = sorted(labels.values(), key=lambda x: (x["n_artists"], x["total_ml"]), reverse=True)
    json.dump(label_list, open(os.path.join(OUT, "label_gaps.json"), "w"), indent=2)

    hot = [s for s in q if s["score"] >= 78]
    warm = [s for s in q if 60 <= s["score"] < 78]
    print(f"Scored {len(scored)} candidates | QUALIFIED (sweet spot): {len(q)}")
    print(f"  HOT (>=78): {len(hot)}   WARM (60-77): {len(warm)}")
    print(f"  Real label/mgmt gaps: {len(label_list)}")
    print("\nTOP 30 QUALIFIED TARGETS (sweet spot 8K-600K ML):")
    for s in q[:30]:
        ml = s["monthly_listeners"] or 0
        print(f"  {s['score']:>5}  {s['name'][:24]:<24} {ml:>8,}ML peers={s['peer_count']:<2} "
              f"{(s['imprint'] or '?')[:20]:<20} {s['timing_note'][:48]}")
    print("\nTOP 20 LABEL / MGMT GAPS (real imprints, sweet-spot rosters):")
    for l in label_list[:20]:
        sr = f" next drop {l['soonest_release']}" if l['soonest_release'] else ""
        print(f"  {l['canonical'][:26]:<26} {l['n_artists']}x  ~{l['total_ml']:>9,}ML best={l['best_score']}{sr}")


if __name__ == "__main__":
    main()

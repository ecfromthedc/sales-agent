#!/usr/bin/env python3
"""Established-artist / label-expansion view.

Eric's ask: beyond the 8K-600K emerging sweet spot, surface the ESTABLISHED artists
(600K+ monthly listeners) that are peers of our roster, at the labels where RT does
LOW volume. Landing a big artist opens/deepens a thin label relationship.

Consumes scored_targets.json (already has ML, imprint, canonical label, releases,
genre, career stage/trend) + crm_rows.json (for our per-label volume).
Outputs out/established_targets.json + out/thin_labels.json
"""
import json, os, re, datetime

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")
TODAY = datetime.date(2026, 6, 5)

# reuse canonicalization from 03 by importing it
import importlib.util
spec = importlib.util.spec_from_file_location("s3", os.path.join(HERE, "03_score_and_map.py"))
s3 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s3)
canonical, SERVED, is_distributor = s3.canonical, s3.SERVED, s3.is_distributor

# Established tiers (monthly listeners)
def tier(ml):
    if ml < 600_000:   return None
    if ml < 2_000_000: return "Established (600K-2M)"
    if ml < 8_000_000: return "Heavy (2M-8M)"
    return "Superstar (8M+)"

# How "deep" we are at a label = client rows there. Strong = Warner/Atlantic only.
STRONG_VOLUME = 25  # >= this many client rows = we already run strong volume here


def crm_volume_by_label(crm):
    from collections import Counter
    c = Counter()
    raw = {}
    for r in crm["clients"]:
        lc = canonical(r["label"])
        if not lc or is_distributor(r["label"]):
            continue
        c[lc] += 1
        raw.setdefault(lc, set()).add((r["label"] or "").strip())
    return c, {k: sorted(v) for k, v in raw.items()}


def genre_fit_label(genre_str):
    g = (genre_str or "").lower()
    if any(k in g for k in ["hip hop", "rap", "r&b", "rnb", "pop", "afro", "latin",
                            "house", "edm", "electronic", "dance"]):
        return "core"
    if any(k in g for k in ["indie", "folk", "alternative", "singer", "country"]):
        return "strong"
    if g.strip():
        return "adjacent"
    return "unknown"


def main():
    crm = json.load(open(os.path.join(OUT, "crm_rows.json")))
    scored = json.load(open(os.path.join(OUT, "scored_targets.json")))
    vol, vol_raw = crm_volume_by_label(crm)

    est = []
    for s in scored:
        ml = s["monthly_listeners"] or 0
        t = tier(ml)
        if not t:
            continue
        # For established artists the clean top-level record_label is the right signal;
        # the release-imprint field is full of distributor/compilation noise at this tier.
        lc = canonical(s.get("record_label"))
        if not lc or is_distributor(s.get("record_label")):
            lc = s["label_canonical"]
        our_vol = vol.get(lc, 0)
        # skip ones at labels where we ALREADY run strong volume (Warner/Atlantic) —
        # those aren't an expansion gap (though still warm; flagged separately)
        strong_here = our_vol >= STRONG_VOLUME
        est.append({
            "name": s["name"], "cm_id": s["cm_id"], "tier": t,
            "monthly_listeners": ml, "sp_followers": s.get("sp_followers"),
            "imprint": s.get("imprint"), "label_canonical": lc,
            "our_volume_at_label": our_vol,
            "label_status": ("STRONG (warm but not a gap)" if strong_here
                             else "THIN — expansion gap" if lc in SERVED or our_vol > 0
                             else "NEW label relationship"),
            "is_distributor_only": s.get("is_distributor_only"),
            "genre": s.get("primary_genre"), "genre_tier": genre_fit_label(s.get("genre_str")),
            "career_stage": s.get("career_stage"), "career_trend": s.get("career_trend"),
            "timing_note": s.get("timing_note"), "release_window": s.get("release_window"),
            "peer_count": s.get("peer_count"), "peer_anchors": (s.get("peer_anchors") or [])[:5],
        })

    # Expansion targets = established artists NOT at a strong-volume label, real genre fit
    expansion = [e for e in est
                 if e["our_volume_at_label"] < STRONG_VOLUME
                 and not e["is_distributor_only"]
                 and e["genre_tier"] in ("core", "strong", "adjacent")]
    # rank: reach (capped) x label-thinness x genre, momentum bonus
    def rank(e):
        reach = min(e["monthly_listeners"], 6_000_000) / 1_000_000
        thin = 3 if e["our_volume_at_label"] == 0 else (2 if e["our_volume_at_label"] < 8 else 1)
        gw = {"core": 1.3, "strong": 1.1, "adjacent": 0.8}.get(e["genre_tier"], 0.6)
        mo = 1.15 if (e["career_trend"] or "").lower().startswith(("up", "rising")) else 1.0
        # prefer reachable (not 20M+ superstar) — mild penalty over 5M
        size_pen = 0.7 if e["monthly_listeners"] > 5_000_000 else 1.0
        return reach * thin * gw * mo * size_pen
    expansion.sort(key=rank, reverse=True)
    json.dump(expansion, open(os.path.join(OUT, "established_targets.json"), "w"), indent=2)

    # Thin-label rollup: labels where we're under-served + the established artists there
    from collections import defaultdict
    bylabel = defaultdict(lambda: {"artists": [], "total_ml": 0})
    for e in expansion:
        lc = e["label_canonical"]
        if not lc:
            continue
        bylabel[lc]["artists"].append({"name": e["name"], "ml": e["monthly_listeners"],
                                       "tier": e["tier"], "window": e["release_window"],
                                       "genre": e["genre"]})
        bylabel[lc]["total_ml"] += e["monthly_listeners"]
    thin = []
    for lc, d in bylabel.items():
        thin.append({"label": lc, "our_volume": vol.get(lc, 0),
                     "raw_names": vol_raw.get(lc, []),
                     "n_established": len(d["artists"]), "total_ml": d["total_ml"],
                     "artists": sorted(d["artists"], key=lambda a: a["ml"], reverse=True)[:10]})
    thin.sort(key=lambda x: (x["n_established"], x["total_ml"]), reverse=True)
    json.dump(thin, open(os.path.join(OUT, "thin_labels.json"), "w"), indent=2)

    realistic = [e for e in expansion if e["monthly_listeners"] <= 5_000_000]
    marquee = [e for e in expansion if e["monthly_listeners"] > 5_000_000]
    print(f"Established artists (600K+ ML) in peer graph: {len(est)}")
    print(f"Expansion targets: {len(expansion)}  (realistic 600K-5M: {len(realistic)} | marquee 5M+: {len(marquee)})")
    print(f"\nA) REALISTIC LABEL-EXPANSION TARGETS (600K-5M ML — landable, deepen a thin label):")
    for e in realistic[:24]:
        print(f"  {e['monthly_listeners']:>9,}ML  {e['name'][:23]:<23} {(e['label_canonical'] or '?')[:14]:<14} "
              f"vol={e['our_volume_at_label']:<2} {e['genre_tier']:<8} {e['timing_note'][:30]}")
    print(f"\nB) MARQUEE (5M+ ML — aspirational; the prize is the LABEL relationship):")
    for e in marquee[:14]:
        print(f"  {e['monthly_listeners']:>11,}ML  {e['name'][:22]:<22} {(e['label_canonical'] or '?')[:14]:<14} vol={e['our_volume_at_label']}")
    print(f"\nC) THIN LABELS — under-served, with established artists we could land:")
    for t in thin[:18]:
        nm = ", ".join(a["name"] for a in t["artists"][:4])
        print(f"  {t['label'][:18]:<18} ourVol={t['our_volume']:<2} {t['n_established']:>2} big ~{t['total_ml']:>12,}ML | {nm}")


if __name__ == "__main__":
    main()

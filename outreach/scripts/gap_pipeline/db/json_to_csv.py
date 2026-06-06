#!/usr/bin/env python3
"""Transform the gap-pipeline JSON outputs into CSVs for Postgres \\copy."""
import json, os, csv, re

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "..", "out")
CSV = os.path.join(HERE, "csv")
os.makedirs(CSV, exist_ok=True)


def load(n):
    return json.load(open(os.path.join(OUT, n)))


def w(name, header, rows):
    with open(os.path.join(CSV, name), "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(header)
        wr.writerows(rows)
    print(f"  {name}: {len(rows)} rows")


def d(x):
    return x if x else None  # empty date -> NULL


crm = load("crm_rows.json")
scored = load("scored_targets.json")
raw = load("candidates_raw.json")
anchor_ids = load("anchor_ids.json")

# canonical label fn mirror (compact)
import importlib.util
spec = importlib.util.spec_from_file_location("s3", os.path.join(HERE, "..", "03_score_and_map.py"))
s3 = importlib.util.module_from_spec(spec); spec.loader.exec_module(s3)
canon, is_distrib, SERVED = s3.canonical, s3.is_distributor, s3.SERVED

# anchors
arows = [(a, anchor_ids.get(a)) for a in crm["client_artists"]]
w("anchors.csv", ["name", "cm_id"], arows)

# labels (from CRM volume + lead labels)
from collections import Counter
vol = Counter()
for r in crm["clients"]:
    lc = canon(r["label"])
    if lc and not is_distrib(r["label"]):
        vol[lc] += 1
label_rows = {}
for lc, n in vol.items():
    label_rows[lc] = (lc, n, False, lc in SERVED, lc in SERVED)
# add labels seen on leads
for s in scored:
    lc = s.get("label_canonical")
    if lc and lc not in label_rows:
        label_rows[lc] = (lc, vol.get(lc, 0), bool(s.get("is_distributor_only")),
                          lc in SERVED, lc in SERVED)
w("labels.csv", ["canonical", "our_volume", "is_distributor", "is_major", "served"],
  list(label_rows.values()))

# leads + edges + releases
lrows, erows, rel = [], [], []
for s in scored:
    cid = s["cm_id"]
    lrows.append((cid, s["name"], s.get("monthly_listeners"), s.get("sp_followers"),
                  s.get("ins_followers"), s.get("cm_artist_score"), s.get("primary_genre"),
                  s.get("genre_str"), s.get("record_label"), s.get("imprint"),
                  s.get("label_canonical"), s.get("is_distributor_only"),
                  s.get("label_already_worked"), s.get("self_released"),
                  s.get("career_stage"), s.get("career_trend"), s.get("qualified"),
                  s.get("score"), s.get("campaign_fit"), s.get("timing_note"),
                  d(s.get("release_window")), s.get("hometown"), s.get("peer_count")))
    for a in (s.get("peer_anchors") or []):
        erows.append((cid, a))
    for r in (s.get("clean_releases") or []):
        rel.append((cid, r.get("name"), d((r.get("release_date") or "")[:10]), r.get("label")))
w("leads.csv", ["cm_id", "name", "monthly_listeners", "sp_followers", "ins_followers",
               "cm_artist_score", "primary_genre", "genre_str", "record_label", "imprint",
               "label_canonical", "is_distributor_only", "label_already_worked", "self_released",
               "career_stage", "career_trend", "qualified", "score", "campaign_fit",
               "timing_note", "release_window", "hometown", "peer_count"], lrows)
# dedupe edges
erows = list({(a, b) for a, b in erows})
w("peer_edges.csv", ["lead_cm_id", "anchor_name"], erows)
w("releases.csv", ["lead_cm_id", "name", "release_date", "label"], rel)

# raw leads (all 3671) + full edges
enriched_ids = {s["cm_id"] for s in scored}
rrows, rerows = [], []
for cid_s, v in raw.items():
    cid = v["id"]
    rrows.append((cid, v.get("name"), v.get("cm_artist_score"), v.get("sp_followers"),
                  v.get("popularity"), v.get("peer_count"), cid in enriched_ids))
    for a in (v.get("anchors") or []):
        rerows.append((cid, a))
w("raw_leads.csv", ["cm_id", "name", "cm_artist_score", "sp_followers", "popularity",
                    "peer_count", "enriched"], rrows)
rerows = list({(a, b) for a, b in rerows})
w("raw_peer_edges.csv", ["lead_cm_id", "anchor_name"], rerows)

# contacts
crows = []
import glob as _glob
for p in sorted(_glob.glob(os.path.join(OUT, "contacts*.json"))):
    data = json.load(open(p))
    fn = os.path.basename(p)
    for name, info in data.items():
        if name.startswith("_"):
            continue
        for k, val in info.items():
            crows.append((name, k, str(val), fn))
w("contacts.csv", ["lead_name", "kind", "value", "source"], crows)

print("CSV export complete ->", CSV)

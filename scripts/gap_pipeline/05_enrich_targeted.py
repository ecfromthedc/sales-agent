#!/usr/bin/env python3
"""Targeted enrichment that spends limited credits by PRIORITY:
  1. Unenriched country + indie-folk gaps (Eric's focus lanes), by Chartmetric score
  2. Then all other unenriched peers, by Chartmetric score
Reuses 02_crawl's cached enrich(); stops clean on 402 (out of credits) and the
already-written cache means a rebuild loses nothing. Run:
  python3 05_enrich_targeted.py
Then: python3 db/json_to_csv equivalents... (see bottom note).
"""
import json, os, importlib.util, subprocess

HERE = os.path.dirname(__file__)
OUT = os.path.join(HERE, "out")

# import 02_crawl for its cached, rate-limited enrich()
spec = importlib.util.spec_from_file_location("c2", os.path.join(HERE, "02_crawl.py"))
c2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(c2)

# Priority queue from the DB: country/folk unenriched first, then the rest by cm_score
PRIORITY_SQL = r"""
\copy (
  WITH cf AS (
    SELECT rl.cm_id, rl.cm_artist_score, 0 AS prio
    FROM henry.raw_leads rl
    JOIN henry.raw_lead_lane rll ON rll.lead_cm_id = rl.cm_id
    WHERE rll.lane IN ('country','indie-folk') AND NOT rl.enriched
  ),
  rest AS (
    SELECT cm_id, cm_artist_score, 1 AS prio
    FROM henry.raw_leads
    WHERE NOT enriched AND cm_id NOT IN (SELECT cm_id FROM cf)
  )
  SELECT cm_id FROM (SELECT * FROM cf UNION ALL SELECT * FROM rest) q
  ORDER BY prio, cm_artist_score DESC NULLS LAST
) TO STDOUT CSV
"""


def priority_ids():
    out = subprocess.run(["psql", "-d", "henry_gap", "-tAc", PRIORITY_SQL.replace("\\copy (", "").replace(") TO STDOUT CSV", "").strip().rstrip(")")],
                         capture_output=True, text=True)
    # fallback to a plain query if the \copy form is awkward
    q = ("WITH cf AS (SELECT rl.cm_id, rl.cm_artist_score, 0 prio FROM henry.raw_leads rl "
         "JOIN henry.raw_lead_lane rll ON rll.lead_cm_id=rl.cm_id "
         "WHERE rll.lane IN ('country','indie-folk') AND NOT rl.enriched), "
         "rest AS (SELECT cm_id, cm_artist_score, 1 prio FROM henry.raw_leads "
         "WHERE NOT enriched AND cm_id NOT IN (SELECT cm_id FROM cf)) "
         "SELECT cm_id FROM (SELECT * FROM cf UNION ALL SELECT * FROM rest) q "
         "ORDER BY prio, cm_artist_score DESC NULLS LAST")
    r = subprocess.run(["psql", "-d", "henry_gap", "-tAc", q], capture_output=True, text=True)
    return [int(x) for x in r.stdout.split() if x.strip().isdigit()]


def main():
    ids = priority_ids()
    print(f"[targeted] priority queue: {len(ids)} unenriched (country/folk first)", flush=True)
    done = 0
    try:
        for i, cid in enumerate(ids):
            c2.enrich(cid)   # cached + rate-limited; raises SystemExit on 402
            done += 1
            if i % 20 == 0:
                print(f"[targeted] {i}/{len(ids)} enriched (this run: {done})", flush=True)
    except SystemExit as e:
        print(f"[targeted] STOPPED: {e}  (enriched {done} this run before cap)", flush=True)
    print(f"[targeted] done this run: {done}. Rebuild + reload next.", flush=True)


if __name__ == "__main__":
    main()

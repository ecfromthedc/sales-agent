#!/usr/bin/env bash
# One-command sweep: refresh token -> targeted enrich (country/folk first) ->
# rebuild enriched set -> rescore -> established view -> reload Postgres.
# Safe to re-run; stops clean if credits run out and loses nothing (cache-backed).
set -e
cd "$(dirname "$0")/../.."          # repo root
BASE=scripts/gap_pipeline

# 1. fresh token
RT=$(cat .secrets/chartmetric_refresh_token)
curl -s -m 30 -d "{\"refreshtoken\":\"$RT\"}" -H "Content-Type: application/json" \
  -X POST https://api.chartmetric.com/api/token \
  | python3 -c "import sys,json;open('/tmp/cm_token.txt','w').write(json.load(sys.stdin)['token'])"

# 2. credit gate
CODE=$(curl -s -m 15 -H "Authorization: Bearer $(cat /tmp/cm_token.txt)" \
  "https://api.chartmetric.com/api/artist/3487/relatedartists?limit=1" -o /dev/null -w "%{http_code}")
if [ "$CODE" != "200" ]; then echo "Chartmetric still HTTP $CODE — credits not live. Aborting."; exit 1; fi
echo "credits live; starting targeted enrichment..."

# 3. targeted enrichment (country/folk first), then rebuild + rescore + reload
python3 $BASE/05_enrich_targeted.py
python3 - <<'PY'
import json, os, glob
OUT="scripts/gap_pipeline/out"
raw=json.load(open(f"{OUT}/candidates_raw.json"))
ranked=sorted(raw.values(), key=lambda c:(c['peer_count'], c.get('cm_artist_score') or 0), reverse=True)
enr=[]
for c in ranked:
    p=f"{OUT}/cache/meta_{c['id']}.json"
    if os.path.exists(p):
        m=json.load(open(p)); m['peer_count']=c['peer_count']; m['peer_anchors']=c['anchors']; enr.append(m)
json.dump(enr, open(f"{OUT}/candidates_enriched.json","w"), indent=2)
print(f"rebuilt candidates_enriched.json: {len(enr)}")
PY
python3 $BASE/03_score_and_map.py | head -4
python3 $BASE/04_established.py | head -2

# 4. reload Postgres
python3 $BASE/db/json_to_csv.py >/dev/null
psql -d henry_gap -q -f $BASE/db/01_schema.sql
psql -d henry_gap -q -f $BASE/db/02_load.sql
psql -d henry_gap -q -f $BASE/db/03_analyze.sql >/dev/null
echo "DB reloaded. New coverage:"
psql -d henry_gap -P pager=off -tc "SELECT round(100.0*count(*) FILTER (WHERE enriched)/count(*),1)||'% of peers enriched' FROM henry.raw_leads;"

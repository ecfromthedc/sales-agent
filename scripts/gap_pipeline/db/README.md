# Henry Gap DB (`henry_gap`) — dedicated Postgres for the outbound leads agenda

**Dedicated database. Do not co-mingle other projects.** Local Postgres 17 (Homebrew).

```bash
psql -d henry_gap          # connect (schema: henry)
# rebuild from scratch:
psql -d henry_gap -f scripts/gap_pipeline/db/01_schema.sql
python3 scripts/gap_pipeline/db/json_to_csv.py
psql -d henry_gap -f scripts/gap_pipeline/db/02_load.sql
psql -d henry_gap -f scripts/gap_pipeline/db/03_analyze.sql   # builds views + reports
```

## Tables (schema `henry`)
| Table | Rows | What |
|---|---|---|
| `anchors` | 271 | our active CRM client artists (the peer-graph roots) |
| `leads` | 1,108 | enriched gap artists (ML, label, genre, score, timing, career stage) |
| `peer_edges` | ~2k | **relational backbone**: lead → which of our artists it orbits |
| `releases` | ~4.9k | per-lead releases (timing + imprint) |
| `raw_leads` | 3,671 | all peers incl. unenriched (for full-graph analysis) |
| `raw_peer_edges` | ~4.5k | full peer graph (incl. unenriched) |
| `labels` | ~850 | canonical labels + our client volume + served flag |
| `contacts` | 111 | researched outreach contacts (★ = mgmt/label co) |

## Relational views (the "sorting by patterns")
- `anchor_lane` (mat. view) — each of our artists classified into a lane (country, indie-folk, pop, hiphop-rnb, edm, indie-alt) by the genres of the leads orbiting it.
- `lead_lane` — enriched lead's own lane.
- `raw_lead_lane` (mat. view) — **lane propagated to unenriched leads via their anchors** — lets us find country/folk gaps without spending Chartmetric credits.
- `label_lane_density` — label × lane → lead counts, sweet-spot counts, avg ML.
- `lead_affinity` — lead pairs sharing ≥3 of our anchors (tight co-orbit clusters).

## Useful queries
```sql
SET search_path TO henry;

-- Country + indie-folk sweet-spot leads, ranked
SELECT name, monthly_listeners, imprint, score, timing_note
FROM leads WHERE lane_of(primary_genre) IN ('country','indie-folk')
AND qualified ORDER BY score DESC;

-- Country/folk LABELS we don't serve, by density
SELECT * FROM label_lane_density
WHERE lane IN ('country','indie-folk') AND NOT we_serve_label
ORDER BY n_leads DESC;

-- Unenriched country/folk gaps to enrich in the next Chartmetric sweep
SELECT rl.name, rl.cm_artist_score, rll.anchors
FROM raw_leads rl JOIN raw_lead_lane rll ON rll.lead_cm_id=rl.cm_id
WHERE rll.lane IN ('country','indie-folk') AND NOT rl.enriched
ORDER BY rl.cm_artist_score DESC;

-- A lead's contacts
SELECT kind, value FROM contacts WHERE lead_name='Ella Langley';

-- Which of our artists anchor the most gap leads (expansion leverage)
SELECT anchor_name, count(*) FROM peer_edges GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

Refresh after a new Chartmetric sweep: re-run `json_to_csv.py` → `02_load.sql` (truncate+reload) → `03_analyze.sql`.

-- Relational analysis: infer lanes from the peer graph, then sort leads by lane/label.
SET search_path TO henry, public;

-- 1) Infer each ANCHOR's lane from the genres of the enriched leads orbiting it.
DROP MATERIALIZED VIEW IF EXISTS anchor_lane CASCADE;
CREATE MATERIALIZED VIEW anchor_lane AS
SELECT pe.anchor_name,
       mode() WITHIN GROUP (ORDER BY lane_of(l.primary_genre)) AS lane,
       count(*) AS peer_leads
FROM peer_edges pe
JOIN leads l ON l.cm_id = pe.lead_cm_id
WHERE l.primary_genre IS NOT NULL AND lane_of(l.primary_genre) <> 'unknown'
GROUP BY pe.anchor_name;

-- 2) Enriched lead lane = its own genre's lane.
DROP VIEW IF EXISTS lead_lane CASCADE;
CREATE VIEW lead_lane AS
SELECT cm_id, name, lane_of(primary_genre) AS lane FROM leads;

-- 3) Propagate lane to RAW (unenriched) leads via the dominant lane of their anchors.
DROP MATERIALIZED VIEW IF EXISTS raw_lead_lane CASCADE;
CREATE MATERIALIZED VIEW raw_lead_lane AS
SELECT rpe.lead_cm_id,
       mode() WITHIN GROUP (ORDER BY al.lane) AS lane,
       count(*) AS anchor_support,
       array_agg(DISTINCT rpe.anchor_name) AS anchors
FROM raw_peer_edges rpe
JOIN anchor_lane al ON al.anchor_name = rpe.anchor_name
GROUP BY rpe.lead_cm_id;

-- 4) Label x lane density (which labels concentrate which lanes among our gaps)
DROP VIEW IF EXISTS label_lane_density CASCADE;
CREATE VIEW label_lane_density AS
SELECT l.label_canonical, lane_of(l.primary_genre) AS lane,
       count(*) AS n_leads,
       count(*) FILTER (WHERE l.qualified) AS n_sweetspot,
       round(avg(l.monthly_listeners)) AS avg_ml,
       max(l.score) AS best_score,
       bool_or(lab.served) AS we_serve_label
FROM leads l LEFT JOIN labels lab ON lab.canonical = l.label_canonical
WHERE l.label_canonical IS NOT NULL AND l.label_canonical <> ''
  AND NOT coalesce(l.is_distributor_only,false)
GROUP BY l.label_canonical, lane_of(l.primary_genre);

-- 5) Relational affinity: lead pairs that share >=3 of our anchors (tight co-orbit clusters)
DROP VIEW IF EXISTS lead_affinity CASCADE;
CREATE VIEW lead_affinity AS
SELECT a.lead_cm_id AS lead_a, b.lead_cm_id AS lead_b, count(*) AS shared_anchors
FROM peer_edges a JOIN peer_edges b
  ON a.anchor_name = b.anchor_name AND a.lead_cm_id < b.lead_cm_id
GROUP BY a.lead_cm_id, b.lead_cm_id
HAVING count(*) >= 3;

REFRESH MATERIALIZED VIEW anchor_lane;
REFRESH MATERIALIZED VIEW raw_lead_lane;

\echo '\n===== OUR ROSTER BY INFERRED LANE (anchors classified via peer graph) ====='
SELECT lane, count(*) AS anchors FROM anchor_lane GROUP BY lane ORDER BY 2 DESC;

\echo '\n===== COUNTRY + INDIE-FOLK: top qualified sweet-spot leads ====='
SELECT l.name, l.monthly_listeners AS ml, lane_of(l.primary_genre) AS lane,
       l.imprint, l.score, l.timing_note
FROM leads l
WHERE lane_of(l.primary_genre) IN ('country','indie-folk') AND l.qualified
ORDER BY l.score DESC, l.monthly_listeners DESC LIMIT 25;

\echo '\n===== COUNTRY + INDIE-FOLK: label / cluster density (real imprints) ====='
SELECT label_canonical, lane, n_leads, n_sweetspot, avg_ml, best_score, we_serve_label
FROM label_lane_density
WHERE lane IN ('country','indie-folk') AND n_leads >= 1
ORDER BY n_leads DESC, avg_ml DESC LIMIT 25;

\echo '\n===== COUNTRY + INDIE-FOLK: established artists (600k+ ML) at thin/no labels ====='
SELECT l.name, l.monthly_listeners AS ml, lane_of(l.primary_genre) AS lane,
       l.imprint, coalesce(lab.our_volume,0) AS our_vol, l.career_trend
FROM leads l LEFT JOIN labels lab ON lab.canonical = l.label_canonical
WHERE lane_of(l.primary_genre) IN ('country','indie-folk')
  AND l.monthly_listeners >= 600000
  AND coalesce(lab.our_volume,0) < 25
ORDER BY l.monthly_listeners DESC LIMIT 25;

\echo '\n===== COUNTRY + INDIE-FOLK: UNENRICHED raw gaps to prioritize in next sweep ====='
SELECT rl.name, rl.cm_artist_score AS cm_score, rl.sp_followers, rll.anchor_support,
       array_to_string(rll.anchors[1:4], ', ') AS sample_anchors
FROM raw_leads rl
JOIN raw_lead_lane rll ON rll.lead_cm_id = rl.cm_id
WHERE rll.lane IN ('country','indie-folk') AND NOT rl.enriched
ORDER BY rl.cm_artist_score DESC NULLS LAST LIMIT 30;

-- Henry Gap DB — dedicated schema for outbound leads + relational (peer-graph) analysis.
-- The peer-graph edges (lead -> our roster anchor) are the relational backbone:
-- a lead's "lane" is inferred from which of our artists it orbits.

DROP SCHEMA IF EXISTS henry CASCADE;
CREATE SCHEMA henry;
SET search_path TO henry, public;

-- Our existing CRM roster (the anchors the peer graph is built from)
CREATE TABLE anchors (
  name            text PRIMARY KEY,
  cm_id           bigint
);

-- Labels / distributors, with how deep WE already are (client-row volume)
CREATE TABLE labels (
  canonical       text PRIMARY KEY,
  our_volume      int  DEFAULT 0,      -- # of our client rows on this label
  is_distributor  boolean DEFAULT false,
  is_major        boolean DEFAULT false,
  served          boolean DEFAULT false -- we already run campaigns here
);

-- Enriched leads (gap artists not in our CRM) — full Chartmetric detail
CREATE TABLE leads (
  cm_id               bigint PRIMARY KEY,
  name                text NOT NULL,
  monthly_listeners   bigint,
  sp_followers        bigint,
  ins_followers       bigint,
  cm_artist_score     numeric,
  primary_genre       text,
  genre_str           text,
  record_label        text,
  imprint             text,
  label_canonical     text,
  is_distributor_only boolean,
  label_already_worked boolean,
  self_released       boolean,
  career_stage        text,
  career_trend        text,
  qualified           boolean,         -- in sweet spot 8k-600k ML
  score               numeric,
  campaign_fit        text,
  timing_note         text,
  release_window      date,
  hometown            text,
  peer_count          int              -- # of our anchors this lead orbits
);

-- THE RELATIONAL BACKBONE: lead -> anchor peer edges
CREATE TABLE peer_edges (
  lead_cm_id      bigint,
  anchor_name     text,
  PRIMARY KEY (lead_cm_id, anchor_name)
);

-- Releases per lead (timing + which imprint they actually drop on)
CREATE TABLE releases (
  lead_cm_id      bigint,
  name            text,
  release_date    date,
  label           text
);

-- Raw candidates (all 3,671 peers incl. unenriched) for full-graph relational analysis
CREATE TABLE raw_leads (
  cm_id           bigint PRIMARY KEY,
  name            text,
  cm_artist_score numeric,
  sp_followers    bigint,
  popularity      int,
  peer_count      int,
  enriched        boolean DEFAULT false
);
CREATE TABLE raw_peer_edges (
  lead_cm_id      bigint,
  anchor_name     text,
  PRIMARY KEY (lead_cm_id, anchor_name)
);

-- Researched outreach contacts
CREATE TABLE contacts (
  lead_name       text,
  kind            text,    -- management / booking / label / email / ig / play / note
  value           text,
  source          text
);

CREATE INDEX ON leads (label_canonical);
CREATE INDEX ON leads (qualified, score DESC);
CREATE INDEX ON peer_edges (anchor_name);
CREATE INDEX ON raw_peer_edges (anchor_name);

-- ---------------------------------------------------------------------------
-- Lane classification: map a primary genre -> RT lane
CREATE OR REPLACE FUNCTION henry.lane_of(g text) RETURNS text AS $$
  SELECT CASE
    WHEN g IS NULL THEN 'unknown'
    WHEN g ILIKE '%country%' OR g ILIKE '%americana%' OR g ILIKE '%bluegrass%' THEN 'country'
    WHEN g ILIKE '%folk%' OR g ILIKE '%singer-songwriter%' OR g ILIKE '%indie folk%' THEN 'indie-folk'
    WHEN g ILIKE '%hip hop%' OR g ILIKE '%hip-hop%' OR g ILIKE '%rap%' OR g ILIKE '%r&b%' OR g ILIKE '%rnb%' THEN 'hiphop-rnb'
    WHEN g ILIKE '%edm%' OR g ILIKE '%house%' OR g ILIKE '%electronic%' OR g ILIKE '%dance%' OR g ILIKE '%dnb%' OR g ILIKE '%dubstep%' OR g ILIKE '%techno%' THEN 'edm'
    WHEN g ILIKE '%pop%' THEN 'pop'
    WHEN g ILIKE '%indie%' OR g ILIKE '%alternative%' OR g ILIKE '%alt%' OR g ILIKE '%rock%' THEN 'indie-alt'
    ELSE 'other'
  END;
$$ LANGUAGE sql IMMUTABLE;

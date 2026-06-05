-- Henry Outreach Agent — Lead Intelligence Database
-- Shared Postgres for all lead-side agent teams
-- Created: 2026-05-20

-- =============================================================
-- LABELS
-- =============================================================
CREATE TABLE IF NOT EXISTS labels (
    id              SERIAL PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    spotify_label   TEXT,                          -- exact Spotify label string
    relationship    TEXT CHECK (relationship IN ('active_client','past_client','prospect','unknown')) DEFAULT 'unknown',
    primary_contact TEXT,
    contact_email   TEXT,
    contact_role    TEXT,
    genres          TEXT[],
    avg_release_cadence_days INTEGER,
    last_release_date DATE,
    notes           TEXT,
    notion_page_id  TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- ARTISTS
-- =============================================================
CREATE TABLE IF NOT EXISTS artists (
    id                  SERIAL PRIMARY KEY,
    name                TEXT NOT NULL,
    spotify_id          TEXT UNIQUE,
    spotify_url         TEXT,
    image_url           TEXT,
    label_id            INTEGER REFERENCES labels(id),
    label_name_raw      TEXT,                      -- raw label from Spotify album metadata
    tier                TEXT CHECK (tier IN ('emerging','mid','established','major')),
    monthly_listeners   INTEGER,
    followers           INTEGER,
    genres              TEXT[],
    is_independent      BOOLEAN DEFAULT false,
    has_worked_with_rt  BOOLEAN DEFAULT false,
    management_company  TEXT,
    manager_name        TEXT,
    manager_email       TEXT,
    notion_page_id      TEXT,
    crm_pipeline_status TEXT,
    crm_campaign_stage  TEXT,
    crm_future_potential TEXT,
    crm_media_spend     NUMERIC(10,2),
    crm_contact_email   TEXT,
    crm_contact_name    TEXT,
    crm_contact_role    TEXT,
    crm_song_name       TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now(),
    UNIQUE(name, spotify_id)
);

-- =============================================================
-- ARTIST RELATIONSHIPS (Spotify "related artists" graph)
-- =============================================================
CREATE TABLE IF NOT EXISTS artist_relationships (
    id              SERIAL PRIMARY KEY,
    artist_id       INTEGER NOT NULL REFERENCES artists(id),
    related_artist_id INTEGER NOT NULL REFERENCES artists(id),
    relationship_type TEXT DEFAULT 'spotify_related',  -- spotify_related, same_label, same_genre, collab
    strength        REAL CHECK (strength >= 0 AND strength <= 1),
    detected_at     TIMESTAMPTZ DEFAULT now(),
    UNIQUE(artist_id, related_artist_id, relationship_type)
);

-- =============================================================
-- LEADS (scored outreach opportunities)
-- =============================================================
CREATE TABLE IF NOT EXISTS leads (
    id              SERIAL PRIMARY KEY,
    artist_id       INTEGER REFERENCES artists(id),
    label_id        INTEGER REFERENCES labels(id),
    score           INTEGER CHECK (score >= 0 AND score <= 100),
    status          TEXT CHECK (status IN ('new','scored','drafted','sent','replied','converted','passed')) DEFAULT 'new',
    signals         JSONB DEFAULT '[]',
    score_breakdown JSONB,                         -- {genreFit, tierFit, timing, relationshipProximity, recency}
    score_reasoning TEXT,
    notion_page_id  TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- OUTREACH LOG (drafts, sends, responses)
-- =============================================================
CREATE TABLE IF NOT EXISTS outreach_log (
    id              SERIAL PRIMARY KEY,
    lead_id         INTEGER REFERENCES leads(id),
    subject         TEXT,
    body            TEXT,
    recipient_name  TEXT,
    recipient_email TEXT,
    status          TEXT CHECK (status IN ('draft','approved','sent','replied','no_response','bounced')) DEFAULT 'draft',
    context_used    TEXT[],                        -- what data points the AI referenced
    gmail_draft_id  TEXT,
    sent_at         TIMESTAMPTZ,
    response_at     TIMESTAMPTZ,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- OUTREACH SIGNALS (timing events detected by watchers)
-- =============================================================
CREATE TABLE IF NOT EXISTS outreach_signals (
    id              SERIAL PRIMARY KEY,
    artist_id       INTEGER REFERENCES artists(id),
    label_id        INTEGER REFERENCES labels(id),
    signal_type     TEXT CHECK (signal_type IN ('upcoming_release','gap_in_coverage','relationship_proximity','genre_fit','social_growth')),
    description     TEXT,
    strength        REAL CHECK (strength >= 0 AND strength <= 1),
    is_processed    BOOLEAN DEFAULT false,
    lead_id         INTEGER REFERENCES leads(id),  -- linked once converted to a lead
    detected_at     TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- RELEASE HISTORY (tracked from Spotify scans)
-- =============================================================
CREATE TABLE IF NOT EXISTS releases (
    id              SERIAL PRIMARY KEY,
    artist_id       INTEGER REFERENCES artists(id),
    name            TEXT NOT NULL,
    release_date    DATE,
    release_type    TEXT CHECK (release_type IN ('single','album','ep','compilation')),
    track_count     INTEGER,
    spotify_album_id TEXT UNIQUE,
    label_name      TEXT,
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- =============================================================
-- SCAN LOG (audit trail for agent runs)
-- =============================================================
CREATE TABLE IF NOT EXISTS scan_log (
    id              SERIAL PRIMARY KEY,
    scan_type       TEXT NOT NULL,                 -- release_scan, gap_analysis, lead_scoring, inbox_clean, ecosystem_map
    labels_scanned  INTEGER DEFAULT 0,
    artists_scanned INTEGER DEFAULT 0,
    signals_found   INTEGER DEFAULT 0,
    leads_created   INTEGER DEFAULT 0,
    errors          TEXT[],
    metadata        JSONB,
    started_at      TIMESTAMPTZ DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

-- =============================================================
-- INDEXES
-- =============================================================
CREATE INDEX idx_artists_spotify_id ON artists(spotify_id);
CREATE INDEX idx_artists_label_id ON artists(label_id);
CREATE INDEX idx_artists_has_worked ON artists(has_worked_with_rt);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_score ON leads(score DESC);
CREATE INDEX idx_signals_type ON outreach_signals(signal_type);
CREATE INDEX idx_signals_unprocessed ON outreach_signals(is_processed) WHERE is_processed = false;
CREATE INDEX idx_releases_artist ON releases(artist_id);
CREATE INDEX idx_releases_date ON releases(release_date DESC);
CREATE INDEX idx_relationships_artist ON artist_relationships(artist_id);
CREATE INDEX idx_relationships_related ON artist_relationships(related_artist_id);
CREATE INDEX idx_outreach_lead ON outreach_log(lead_id);

-- =============================================================
-- UPDATED_AT TRIGGER
-- =============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_labels_updated BEFORE UPDATE ON labels FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_artists_updated BEFORE UPDATE ON artists FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_leads_updated BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_updated_at();

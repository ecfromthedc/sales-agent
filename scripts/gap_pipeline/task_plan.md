# Henry Gap Analysis — Build Plan

**Goal:** Map labels/management cos RT isn't working with that represent peers of our
271 active client artists, find the chartable/emerging/budgeted artists in our sweet spot,
pull pointed contacts, and draft release-timed outreach.

## Pipeline
- [x] Verify Chartmetric token + endpoints (relatedartists, /artist/:id, /albums, career_status)
- [x] Pull RT CRM via Notion API → 630 rows, 271 client artists, 73 labels touched (01_dump_crm.py)
- [x] Build resumable Chartmetric crawler (02_crawl.py) — anchors→peers→exclude CRM→enrich
- [x] Crawler run complete → candidates_enriched.json
- [x] Build scoring + label/mgmt gap rollup (03_score_and_map.py)
- [x] Run scoring → scored_targets.json + label_gaps.json
- [x] Contact enrichment (top targets via WebSearch; Perplexity key dead) for HOT targets (CM contacts + Perplexity/Firecrawl for A&R/mgmt emails)
- [x] Draft release-timed outreach emails for top targets (grounded in real data only)
- [x] Deliverable: Gap Map (Obsidian + repo); Notion/Gmail push pending Eric review doc (Obsidian) + optionally push HOT leads to Notion Leads DB

## Key facts
- Active lane: pop, country, EDM, indie-folk, hip-hop/R&B. Deep with majors already.
- Gap = peer artists + indie labels/mgmt in our lane NOT in CRM (300/QC/TDE/SubPop/etc. absent)
- Sweet spot: 10K–500K Spotify ML, active release window, genre match
- NEVER auto-send. Draft only. Never invent metrics.

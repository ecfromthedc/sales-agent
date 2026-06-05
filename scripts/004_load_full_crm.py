#!/usr/bin/env python3
"""
004_load_full_crm.py — Load full CRM export into henry_intel Postgres database.

Reads full_crm_export.json (592 records, ~337 unique artists) and:
1. Upserts artists (most recent campaign per artist wins)
2. Upserts labels with relationship classification
3. Links artists → labels via label_id FK

Usage:
    python3 scripts/004_load_full_crm.py
"""

import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB = "henry_intel"
SCRIPT_DIR = Path(__file__).parent
JSON_PATH = SCRIPT_DIR / "full_crm_export.json"

DONE_STAGES = {"Done", "Posts are live", "Posts are finished", "Campaign report"}

# Labels to skip (not real labels)
SKIP_LABELS = {"Unknown", "N/A", "", None}


def psql(sql: str) -> str:
    """Run a SQL statement via psql and return stdout."""
    result = subprocess.run(
        [PSQL, "-d", DB, "-t", "-A", "-c", sql],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"PSQL ERROR: {result.stderr}", file=sys.stderr)
        print(f"SQL: {sql[:200]}", file=sys.stderr)
    return result.stdout.strip()


def escape_sql(val: str | None) -> str:
    """Escape a string for SQL, handling NULLs and single quotes."""
    if val is None:
        return "NULL"
    escaped = val.replace("'", "''")
    return f"'{escaped}'"


def main():
    # Load JSON
    with open(JSON_PATH) as f:
        data = json.load(f)

    records = data["records"]
    print(f"Loaded {len(records)} records from CRM export")

    # ── Step 1: Group records by artist, pick most recent campaign ──
    artist_campaigns: dict[str, list[dict]] = defaultdict(list)
    for rec in records:
        name = (rec.get("artist_name") or "").strip()
        if not name:
            continue
        artist_campaigns[name].append(rec)

    print(f"Found {len(artist_campaigns)} unique artists")

    # For each artist, sort campaigns by created_time descending, pick most recent
    artist_records: dict[str, dict] = {}
    artist_all_campaigns: dict[str, list[dict]] = {}
    for name, campaigns in artist_campaigns.items():
        campaigns.sort(key=lambda r: r.get("created_time") or "", reverse=True)
        artist_records[name] = campaigns[0]  # most recent
        artist_all_campaigns[name] = campaigns

    # ── Step 2: Extract unique labels and classify relationships ──
    label_campaign_counts: dict[str, dict] = defaultdict(lambda: {"completed": 0, "leads": 0})
    for rec in records:
        label = (rec.get("label") or "").strip()
        if label in SKIP_LABELS:
            continue
        stage = rec.get("campaign_stage") or ""
        if stage in DONE_STAGES:
            label_campaign_counts[label]["completed"] += 1
        else:
            label_campaign_counts[label]["leads"] += 1

    print(f"Found {len(label_campaign_counts)} unique labels (excluding Unknown/N/A)")

    # Upsert labels
    labels_upserted = 0
    for label_name, counts in label_campaign_counts.items():
        completed = counts["completed"]
        if completed >= 3:
            relationship = "active_client"
        elif completed >= 1:
            relationship = "past_client"
        else:
            relationship = "prospect"

        sql = f"""
            INSERT INTO labels (name, relationship)
            VALUES ({escape_sql(label_name)}, '{relationship}')
            ON CONFLICT (name) DO UPDATE SET
                relationship = CASE
                    WHEN EXCLUDED.relationship = 'active_client' THEN 'active_client'
                    WHEN EXCLUDED.relationship = 'past_client' AND labels.relationship NOT IN ('active_client') THEN 'past_client'
                    ELSE labels.relationship
                END,
                updated_at = NOW();
        """
        psql(sql)
        labels_upserted += 1

    print(f"Upserted {labels_upserted} labels")

    # ── Step 3: Upsert artists ──
    artists_inserted = 0
    artists_updated = 0

    for name, rec in artist_records.items():
        all_campaigns = artist_all_campaigns[name]
        has_worked = any(c.get("campaign_stage") in DONE_STAGES for c in all_campaigns)

        # Sum total media spend across all campaigns
        total_spend = sum(c.get("media_spend") or 0 for c in all_campaigns)

        label_raw = (rec.get("label") or "").strip() or None
        contact_email = rec.get("contact_email")
        contact_name = rec.get("contact_name")
        # contact_role is an array in the JSON, join it
        contact_role_list = rec.get("contact_role") or []
        contact_role = ", ".join(contact_role_list) if contact_role_list else None
        campaign_stage = rec.get("campaign_stage")
        pipeline_status = rec.get("pipeline_status")
        media_spend = total_spend if total_spend > 0 else None
        future_potential = rec.get("future_potential")
        song_name = rec.get("song_name")
        notion_page_id = rec.get("notion_page_id")

        # Check if artist already exists (by name, where spotify_id is null or matching)
        existing = psql(
            f"SELECT id, spotify_id FROM artists WHERE LOWER(name) = LOWER({escape_sql(name)}) LIMIT 1;"
        )

        if existing:
            # Artist exists — UPDATE with CRM data
            artist_id = existing.split("|")[0]
            set_clauses = []
            if label_raw and label_raw not in SKIP_LABELS:
                set_clauses.append(f"label_name_raw = {escape_sql(label_raw)}")
            if contact_email:
                set_clauses.append(f"crm_contact_email = {escape_sql(contact_email)}")
            if contact_name:
                set_clauses.append(f"crm_contact_name = {escape_sql(contact_name)}")
            if contact_role:
                set_clauses.append(f"crm_contact_role = {escape_sql(contact_role)}")
            if campaign_stage:
                set_clauses.append(f"crm_campaign_stage = {escape_sql(campaign_stage)}")
            if pipeline_status:
                set_clauses.append(f"crm_pipeline_status = {escape_sql(pipeline_status)}")
            if media_spend is not None:
                set_clauses.append(f"crm_media_spend = {media_spend}")
            if future_potential:
                set_clauses.append(f"crm_future_potential = {escape_sql(future_potential)}")
            if song_name:
                set_clauses.append(f"crm_song_name = {escape_sql(song_name)}")
            if notion_page_id:
                set_clauses.append(f"notion_page_id = {escape_sql(notion_page_id)}")
            set_clauses.append(f"has_worked_with_rt = {has_worked}")

            if set_clauses:
                sql = f"UPDATE artists SET {', '.join(set_clauses)} WHERE id = {artist_id};"
                psql(sql)
                artists_updated += 1
        else:
            # New artist — INSERT
            sql = f"""
                INSERT INTO artists (
                    name, label_name_raw, crm_contact_email, crm_contact_name,
                    crm_contact_role, crm_campaign_stage, crm_pipeline_status,
                    crm_media_spend, crm_future_potential, crm_song_name,
                    notion_page_id, has_worked_with_rt
                ) VALUES (
                    {escape_sql(name)},
                    {escape_sql(label_raw)},
                    {escape_sql(contact_email)},
                    {escape_sql(contact_name)},
                    {escape_sql(contact_role)},
                    {escape_sql(campaign_stage)},
                    {escape_sql(pipeline_status)},
                    {media_spend if media_spend is not None else 'NULL'},
                    {escape_sql(future_potential)},
                    {escape_sql(song_name)},
                    {escape_sql(notion_page_id)},
                    {has_worked}
                );
            """
            psql(sql)
            artists_inserted += 1

    print(f"Artists inserted: {artists_inserted}, updated: {artists_updated}")

    # ── Step 4: Link artists to labels via label_id ──
    linked = 0
    # Get all label name→id mappings
    label_rows = psql("SELECT id, name FROM labels;")
    label_id_map: dict[str, int] = {}
    for row in label_rows.split("\n"):
        if "|" in row:
            parts = row.split("|", 1)
            label_id_map[parts[1].strip()] = int(parts[0].strip())

    for name, rec in artist_records.items():
        label_raw = (rec.get("label") or "").strip()
        if label_raw in SKIP_LABELS:
            continue
        label_id = label_id_map.get(label_raw)
        if label_id:
            psql(
                f"UPDATE artists SET label_id = {label_id} "
                f"WHERE LOWER(name) = LOWER({escape_sql(name)}) AND (label_id IS NULL OR label_id != {label_id});"
            )
            linked += 1

    print(f"Linked {linked} artists to labels")

    # ── Step 5: Verification queries ──
    print("\n" + "=" * 60)
    print("VERIFICATION")
    print("=" * 60)

    total = psql("SELECT COUNT(*) FROM artists;")
    print(f"\nTotal artists: {total}")

    worked = psql("SELECT COUNT(*) FROM artists WHERE has_worked_with_rt = true;")
    print(f"Artists with has_worked_with_rt = true: {worked}")

    labels_total = psql("SELECT COUNT(*) FROM labels;")
    print(f"Total labels: {labels_total}")

    print("\nCampaign stage distribution:")
    stages = psql(
        "SELECT crm_campaign_stage, COUNT(*) FROM artists "
        "WHERE crm_campaign_stage IS NOT NULL "
        "GROUP BY crm_campaign_stage ORDER BY COUNT(*) DESC;"
    )
    for row in stages.split("\n"):
        if row.strip():
            print(f"  {row}")

    print("\nTop 10 labels by artist count:")
    top_labels = psql(
        "SELECT l.name, l.relationship, COUNT(a.id) as artist_count "
        "FROM labels l LEFT JOIN artists a ON a.label_id = l.id "
        "GROUP BY l.id, l.name, l.relationship "
        "ORDER BY artist_count DESC LIMIT 10;"
    )
    for row in top_labels.split("\n"):
        if row.strip():
            print(f"  {row}")

    print("\nTop 10 artists by media spend:")
    top_spend = psql(
        "SELECT name, crm_media_spend, label_name_raw, has_worked_with_rt "
        "FROM artists WHERE crm_media_spend IS NOT NULL "
        "ORDER BY crm_media_spend DESC LIMIT 10;"
    )
    for row in top_spend.split("\n"):
        if row.strip():
            print(f"  {row}")

    print("\nLabel relationship distribution:")
    rel_dist = psql(
        "SELECT relationship, COUNT(*) FROM labels GROUP BY relationship ORDER BY COUNT(*) DESC;"
    )
    for row in rel_dist.split("\n"):
        if row.strip():
            print(f"  {row}")

    print("\nDone.")


if __name__ == "__main__":
    main()

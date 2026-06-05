"""
Load related_artists JSON files into henry_intel Postgres.
Creates new artist entries for related artists not already in the DB,
then populates the artist_relationships table.
"""
import json
import subprocess
from pathlib import Path

DB = "henry_intel"
PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
SCRIPTS = Path(__file__).parent


def run_sql(sql: str) -> str:
    result = subprocess.run(
        [PSQL, DB, "-t", "-c", sql],
        capture_output=True, text=True
    )
    return result.stdout.strip()


def escape(val: str) -> str:
    return val.replace("'", "''")


def load_json(path: Path) -> dict:
    with open(path) as f:
        return json.load(f)


def main() -> None:
    # Load both JSON files
    related: dict[str, list[str]] = {}
    for filename in ["related_artists.json", "related_artists_batch2.json"]:
        path = SCRIPTS / filename
        if path.exists():
            data = load_json(path)
            related.update(data)
            print(f"Loaded {len(data)} artists from {filename}")

    all_related_names: set[str] = set()
    for names in related.values():
        all_related_names.update(names)

    print(f"\nTotal unique related artists: {len(all_related_names)}")

    # Check which related artists are already in the DB
    existing = run_sql("SELECT name FROM artists;")
    existing_set = {n.strip() for n in existing.split("\n") if n.strip()}
    print(f"Existing artists in DB: {len(existing_set)}")

    # Insert new related artists (opportunities) that aren't in our CRM
    new_artists = all_related_names - existing_set
    print(f"New opportunity artists to insert: {len(new_artists)}")

    inserted = 0
    for name in sorted(new_artists):
        sql = f"""INSERT INTO artists (name, has_worked_with_rt, is_independent)
VALUES ('{escape(name)}', false, false)
ON CONFLICT (name, spotify_id) DO NOTHING;"""
        run_sql(sql)
        inserted += 1
    print(f"Inserted {inserted} new opportunity artists.")

    # Now build relationships
    rel_count = 0
    for source_name, targets in related.items():
        # Get source artist ID
        source_id = run_sql(
            f"SELECT id FROM artists WHERE name = '{escape(source_name)}' LIMIT 1;"
        )
        if not source_id:
            continue

        for target_name in targets:
            target_id = run_sql(
                f"SELECT id FROM artists WHERE name = '{escape(target_name)}' LIMIT 1;"
            )
            if not target_id:
                continue

            sql = f"""INSERT INTO artist_relationships (artist_id, related_artist_id, relationship_type, strength)
VALUES ({source_id}, {target_id}, 'spotify_related', 0.7)
ON CONFLICT (artist_id, related_artist_id, relationship_type) DO NOTHING;"""
            run_sql(sql)
            rel_count += 1

    print(f"\nInserted {rel_count} relationships.")

    # Summary
    total_artists = run_sql("SELECT count(*) FROM artists;")
    total_rels = run_sql("SELECT count(*) FROM artist_relationships;")
    rt_clients = run_sql("SELECT count(*) FROM artists WHERE has_worked_with_rt;")
    opportunities = run_sql("SELECT count(*) FROM artists WHERE NOT has_worked_with_rt;")

    print(f"\n=== Henry Intel Database ===")
    print(f"Total artists:    {total_artists}")
    print(f"RT clients:       {rt_clients}")
    print(f"Opportunities:    {opportunities}")
    print(f"Relationships:    {total_rels}")


if __name__ == "__main__":
    main()

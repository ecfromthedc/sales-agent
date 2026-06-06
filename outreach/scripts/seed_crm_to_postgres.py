"""
Seed henry_intel Postgres from CRM data already extracted from Notion.
Run once to populate the initial artists + labels tables.
"""
import subprocess
import json

DB = "henry_intel"
PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"


def run_sql(sql: str) -> str:
    result = subprocess.run(
        [PSQL, DB, "-c", sql],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"SQL error: {result.stderr.strip()}")
    return result.stdout.strip()


# ── Labels extracted from CRM ──────────────────────────────────
labels = [
    ("Warner", "Warner Records", "active_client", "Will Morrow", "will.morrow@warnerrecords.com", "Label Rep", ["pop", "rock", "hip-hop", "country"]),
    ("Atlantic", "Atlantic Records", "active_client", None, None, None, ["pop", "hip-hop", "r&b", "rock"]),
    ("Nettwerk", "Nettwerk Music Group", "active_client", "Victoria Leonard", "vleonard@nettwerk.com", "Label Rep", ["indie", "folk", "pop"]),
    ("Insomniac", "Insomniac Records", "active_client", "Tiana Sandberg", "tiana.sandberg@insomniac.com", "Label Rep", ["electronic"]),
    ("PREACH", "PREACH", "active_client", "Liz", "liz@preach.company", "Label Rep", ["indie", "pop"]),
    ("Stem", "Stem", "past_client", "Kevin Lazan", "Kevin.Lazan@gmail.com", "Label Rep", ["pop"]),
    ("Head Bitch Music", "Head Bitch Music", "past_client", None, None, None, ["pop", "indie"]),
    ("Range Media", "Range Media Partners", "past_client", "F Morris", "fmorris@rangemp.com", "Manager", ["indie", "pop"]),
    ("Sony", "Sony Music", "past_client", "Selina Barnow", "selina.barnow@sonymusic.com", "Label Rep", ["pop", "r&b"]),
    ("Hidden Beach UMG", "Hidden Beach / UMG", "past_client", "Classick", "classick@classickstudios.com", "Manager", ["r&b", "hip-hop"]),
    ("AWAL", "AWAL", "past_client", "Joseph Buscema", "joeb@10thst.com", "Manager", ["pop"]),
    ("DistroKid", "DistroKid", "prospect", None, None, None, []),
    ("TuneCore", "TuneCore", "prospect", None, None, None, []),
    ("TooLost", "TooLost", "prospect", "Jonny Chiappetta", "jonny@jconsult.io", "Manager", ["indie", "pop"]),
    ("Stable Fewture", "Stable Fewture", "past_client", None, None, None, ["indie"]),
    ("Los Hendrix", "Los Hendrix", "prospect", None, None, None, ["hip-hop", "r&b"]),
    ("Spartan", "Spartan Records", "prospect", None, None, None, ["country"]),
    ("Rabbit Agency", "Rabbit Agency", "prospect", None, None, None, ["country"]),
    ("Big Loud Rock", "Big Loud Rock", "prospect", None, None, None, ["rock", "country"]),
    ("Mahogany", "Mahogany", "past_client", "Mark", "mark@wearemahogany.com", "Label Rep", ["indie", "folk"]),
    ("Amigo Records / ADA", "Amigo Records", "prospect", "Jillian", "jillian@prescriptionsongs.com", "Label Rep", ["country"]),
    ("R&R", "R&R", "prospect", None, None, None, ["rock", "country"]),
    ("Independent Co.", "Independent Co.", "past_client", "Aasim", "aasim@independent.co", "Manager", ["indie"]),
    ("South Sound", "South Sound", "prospect", None, None, None, ["indie"]),
    ("GYROstream", "GYROstream", "prospect", "Bobby Uncle", "music@bobbyuncle.com", None, []),
    ("GOTTA MOVE", "GOTTA MOVE", "active_client", "Tiana Sandberg", "tiana.sandberg@insomniac.com", "Label Rep", ["electronic"]),
]

# ── Artists extracted from CRM ─────────────────────────────────
artists = [
    # (name, label_name, has_worked_with_rt, pipeline_status, campaign_stage, future_potential, media_spend, contact_email, contact_name, contact_role, song_name)
    ("Emei", "Atlantic", False, "Lead", "Lead", "High", 750, None, None, None, "Night At The Opera"),
    ("Isaiah Rashad", "Warner", False, "Lead", "Lead", "High", 1000, None, None, None, "Boy In Red"),
    ("Amble", "Warner", True, "Lead", "Done", "High", 1500, "will.morrow@warnerrecords.com", None, None, "Swan Song"),
    ("Limage", "Los Hendrix", False, "Lead", "Lead", "High", 2000, None, None, None, "Dig Me"),
    ("Stella Lefty", "Atlantic", False, "Lead", "Lead", "High", 750, None, None, None, "I know I know"),
    ("Daniel Seavey", "Atlantic", False, "Lead", "Lead", "High", 500, None, None, None, "Time to Time"),
    ("Bella Kay", "Atlantic", True, "Lead", "Done", "High", 1000, None, None, None, "Wonder Wander"),
    ("Jake Marsh", "Spartan", False, "Lead", "Lead", "High", 1500, None, None, None, "Down The Line"),
    ("Tucker Wetmore", "Rabbit Agency", False, "Lead", "Lead", "High", 1000, None, None, None, None),
    ("Sam Barber", "Atlantic", False, "Lead", "Lead", "High", 1000, None, None, None, "Restless Mind"),
    ("Rachel Platten", "Stem", True, "Lead", "Done", None, 3000, "Kevin.Lazan@gmail.com", "Kevin Lazan", "Label Rep", "Fight Song (Rachel's Version)"),
    ("Caleb Hearn", "Nettwerk", True, "Lead", "Done", "High", 1250, "vleonard@nettwerk.com", "Victoria", None, "The Lows"),
    ("Amistat", "Nettwerk", True, "Lead", "Done", "High", 1750, None, None, None, "Seasons"),
    ("Bailey Spinn", "AWAL", True, "Lead", "Done", None, None, "joeb@10thst.com", "Joseph Buscema", "Manager", "critical"),
    ("Mon Rovia", "Nettwerk", True, "Lead", "Done", None, None, None, None, None, None),
    ("Goldford", "Rising Tides", True, "Lead", "Done", None, None, None, None, None, None),
    ("Dasha", "Warner", True, "Lead", "Done", None, None, "will.morrow@warnerrecords.com", None, None, None),
    ("Gavin Adcock", "Warner", True, "Lead", "Done", None, None, "ec@risingtidesent.com", None, None, None),
    ("Gregory Alan Isakov", None, True, "Lead", "Done", None, None, "sarah@suitcasetownmusic.com", "Sarah", None, None),
    ("Myles Smith", "Sony", True, "Lead", "Done", None, None, "selina.barnow@sonymusic.com", "Selina Barnow", "Label Rep", None),
    ("Wild Rivers", "Nettwerk", True, "Lead", "Done", None, None, "liz@nettwerk.com", "Liz", None, None),
    ("Cam Whitcomb", "Atlantic", True, "Lead", "Done", None, None, None, None, None, None),
    ("Lil Tjay", "Warner", True, "Lead", "Done", None, None, "rama@standardrecords.co", "Rama", None, None),
    ("Neil Young", "Warner", True, "Lead", "Done", None, None, "warner@warner.com", None, None, None),
    ("Pecos & The Rooftops", "Warner", True, "Lead", "Done", None, None, None, None, None, None),
    ("Jake Wesley Rogers", "Warner", True, "Lead", "Done", None, None, "Warner@warner.com", None, None, None),
    ("Honey BxBy", "Warner", True, "Lead", "Done", None, None, "will.morrow@warnerrecords.com", None, None, None),
    ("Alex Sucks", "Warner", True, "Lead", "Done", None, None, "will.morrow@warnerrecords.com", None, None, None),
    ("Gannon Fremin", "Warner", True, "Lead", "Done", None, None, "will.morrow@warnerrecords.com", None, None, None),
    ("Cil", "Warner", True, "Lead", "Done", None, None, "will.morrow@warnerrecords.com", None, None, None),
    ("Alan Walker", "Insomniac", True, "Lead", "Done", None, None, None, None, None, None),
    ("Sara Landry", "Insomniac", True, "Lead", "Done", None, None, None, None, None, None),
    ("Electric Guest", "Independent Co.", True, "Lead", "Done", None, None, "aasim@independent.co", "Aasim", "Manager", None),
    ("Haffway", "Range Media", True, "Lead", "Done", None, None, "clutz@rangemp.com", None, None, None),
    ("Haley Joelle", "PREACH", True, "Lead", "Done", None, None, None, None, None, None),
    ("Labrinth", None, True, "Lead", "Done", None, None, None, None, None, None),
    ("Phillip-Michael Scales", "Symphonic", True, "Lead", "Done", None, None, "Phillip@phillip-michael.net", "Phillip-Michael Scales", "Artist", None),
    ("GoldKimono", None, True, "Lead", "Done", None, None, "dan@gafry-management.com", "Dan", "Manager", None),
    ("Gunnar", "Stable Fewture", True, "Lead", "Done", None, None, "liz@preach.company", "Liz", None, None),
    ("Flavia", "PREACH", True, "Lead", "Done", None, None, "liz@preach.company", "Liz", None, None),
    ("Ferester", "Mahogany", True, "Lead", "Done", None, None, "mark@wearemahogany.com", "Mark", "Label Rep", None),
    ("Quadeca", None, True, "Lead", "Done", None, None, None, None, None, None),
    ("Spencer Ludwig", "Head Bitch Music", True, "Lead", "Done", None, None, "spencer@wearetrumpetrecords.com", None, None, None),
    ("Transviolet", "Head Bitch Music", True, "Lead", "Done", None, None, "noisefloornf@gmail.com", None, None, None),
    ("Troy Ramey", "Head Bitch Music", True, "Lead", "Done", None, None, "ramey.troy@gmail.com", "Troy Ramey", "Artist", None),
    ("Family Company", None, True, "Lead", "Done", None, None, "music@familycompanymusic.com", None, None, None),
    ("Nate Bergman", None, True, "Lead", "Done", None, None, "nmbergman@icloud.com", "Nate Bergman", "Artist", None),
    ("Carter Faith", "Universal", True, "Lead", "Done", None, None, None, None, None, None),
    ("Shaya Zamora", "Atlantic", True, "Lead", "Done", None, None, None, None, None, None),
    ("Frayne Vibez", "Hidden Beach UMG", True, "Lead", "Done", None, 750, "classick@classickstudios.com", "Christopher Inumerable", "Manager", "Fall Apart"),
    ("SieteNameKeek", "DistroKid", True, "Lead", "Done", None, 1000, "simonhagos3@gmail.com", "Simon Hagos", "Manager", "Dominique"),
    ("Highup", "TooLost", False, "Lead", "Lead", None, None, "jonny@jconsult.io", "Jonny Chiappetta", "Manager", "Don't Go"),
    ("Chris Burke", "TooLost", False, "Lead", "Lead", None, None, "jonny@jconsult.io", "Jonny Chiappetta", "Manager", "Gimme More"),
    ("Manning Rothrock", "DistroKid", False, "Lead", "Lead", None, None, "zane@jmapromo.com", "Zane Waxman", "Manager", "Way Back When"),
    ("Just Seconds Apart", "TuneCore", False, "Lead", "Lead", None, None, "Shelli3yp@gmail.com", "Just Seconds Apart", "Artist", "Moving On"),
    ("Brady Toops", "DistroKid", False, "Lead", "Lead", None, None, "bradytoops@gmail.com", "Brady Toops", "Artist", "So High"),
    ("Nemahsis", "DistroKid", True, "Lead", "Done", None, None, "chassbryan@gmail.com", None, None, None),
    ("Elvis Drew", "DistroKid", True, "Lead", "Done", None, None, "elvisdrewbooking@gmail.com", None, None, None),
    ("Mattilo", "Insomniac", True, "Lead", "Done", None, None, None, None, None, None),
    ("Them & I", "Range Media", True, "Lead", "Done", None, None, "fmorris@rangemp.com", "F Morris", None, None),
    ("All American Rejects", None, True, "Lead", "Done", None, None, None, "Jenni", None, None),
    ("Diplo", None, True, "Lead", "Done", None, None, None, None, None, None),
    ("Alex Aiono", None, True, "Lead", "Done", None, None, None, None, None, None),
    ("Pressa", None, True, "Lead", "Done", None, None, "jferrari@bfrthelabel.com", None, None, None),
    ("Kaleb Cohen", None, True, "Lead", "Done", None, None, "sarah@over-and-out.co", "Sarah", None, None),
    ("Big Boss Vette", None, True, "Lead", "Done", None, None, None, None, None, None),
    ("Wyclef Jean", None, True, "Lead", "Done", None, None, None, None, None, None),
    ("Bobby Uncle", "GYROstream", True, "Lead", "Posts Live", None, None, "music@bobbyuncle.com", "Bobby Uncle", "Artist", None),
]

# Remove the extra None from Mon Rovia and Goldford (11 fields, not 12)
# Fix: some entries have 12 elements, trim them
artists_clean = []
for a in artists:
    if len(a) > 11:
        artists_clean.append(a[:11])
    else:
        artists_clean.append(a)


def escape(val):
    if val is None:
        return "NULL"
    s = str(val).replace("'", "''")
    return f"'{s}'"


def pg_array(arr):
    if not arr:
        return "NULL"
    items = ",".join(f'"{x}"' for x in arr)
    return f"'{{{items}}}'"


# Insert labels
print("Inserting labels...")
for lb in labels:
    name, spotify, rel, contact, email, role, genres = lb
    sql = f"""INSERT INTO labels (name, spotify_label, relationship, primary_contact, contact_email, contact_role, genres)
VALUES ({escape(name)}, {escape(spotify)}, {escape(rel)}, {escape(contact)}, {escape(email)}, {escape(role)}, {pg_array(genres)})
ON CONFLICT (name) DO UPDATE SET
  spotify_label = EXCLUDED.spotify_label,
  relationship = EXCLUDED.relationship,
  primary_contact = EXCLUDED.primary_contact,
  contact_email = EXCLUDED.contact_email,
  contact_role = EXCLUDED.contact_role,
  genres = EXCLUDED.genres;"""
    run_sql(sql)
print(f"  {len(labels)} labels inserted.")

# Insert artists
print("Inserting artists...")
for a in artists_clean:
    name, label_name, worked, pipeline, campaign, future, spend, cemail, cname, crole, song = a

    # Look up label_id
    label_id_sql = "NULL"
    if label_name and label_name not in ("Rising Tides", "Symphonic", "Universal"):
        label_id_sql = f"(SELECT id FROM labels WHERE name = {escape(label_name)} LIMIT 1)"

    spend_val = str(spend) if spend else "NULL"

    sql = f"""INSERT INTO artists (name, label_name_raw, label_id, has_worked_with_rt, crm_pipeline_status, crm_campaign_stage, crm_future_potential, crm_media_spend, crm_contact_email, crm_contact_name, crm_contact_role, crm_song_name)
VALUES ({escape(name)}, {escape(label_name)}, {label_id_sql}, {str(worked).lower()}, {escape(pipeline)}, {escape(campaign)}, {escape(future)}, {spend_val}, {escape(cemail)}, {escape(cname)}, {escape(crole)}, {escape(song)})
ON CONFLICT (name, spotify_id) DO NOTHING;"""
    run_sql(sql)
print(f"  {len(artists_clean)} artists inserted.")

# Verify
print("\nVerification:")
print(run_sql("SELECT count(*) AS label_count FROM labels;"))
print(run_sql("SELECT count(*) AS artist_count FROM artists;"))
print(run_sql("SELECT count(*) AS worked_with_rt FROM artists WHERE has_worked_with_rt;"))
print(run_sql("SELECT name, relationship FROM labels ORDER BY relationship, name;"))

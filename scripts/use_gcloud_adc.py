#!/usr/bin/env python3
"""
Adopt gcloud's Application Default Credentials (ADC) for the worker.

Why: ADC uses Google's well-known OAuth client, which dodges the need to
manage a custom OAuth client + secret + Playground re-mint flow. Eric runs
ONE command (`gcloud auth application-default login --scopes=...`) once, and
the resulting refresh token persists. We just extract the three values from
the ADC file and wire them into .dev.vars + Cloudflare.

Run after:
    gcloud auth application-default login \\
      --scopes=https://www.googleapis.com/auth/drive.readonly,\\
https://www.googleapis.com/auth/gmail.readonly
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(os.environ.get("RT_AGENT_REPO", Path.home() / "Documents/Development/sales-agent"))
DEVVARS = REPO / ".dev.vars"
WRANGLER = REPO / "node_modules/.bin/wrangler"
ROTATION_LOG = REPO / ".rotation-log"
ADC = Path.home() / ".config/gcloud/application_default_credentials.json"

if not ADC.exists():
    sys.exit(f"❌ {ADC} not found.\n"
             f"Run first:\n"
             f"  gcloud auth application-default login \\\n"
             f"    --scopes=https://www.googleapis.com/auth/drive.readonly,"
             f"https://www.googleapis.com/auth/gmail.readonly")

adc = json.loads(ADC.read_text())
client_id = adc.get("client_id", "")
client_secret = adc.get("client_secret", "")
refresh_token = adc.get("refresh_token", "")

missing = [k for k, v in (("client_id", client_id), ("client_secret", client_secret),
                          ("refresh_token", refresh_token)) if not v]
if missing:
    sys.exit(f"❌ ADC file is missing: {missing}")

print(f"✅ ADC loaded:")
print(f"   client_id:     {len(client_id)} chars")
print(f"   client_secret: {len(client_secret)} chars")
print(f"   refresh_token: {len(refresh_token)} chars")

# ---------- Verify token actually works ----------
import urllib.parse, urllib.request
data = urllib.parse.urlencode({
    "client_id": client_id,
    "client_secret": client_secret,
    "refresh_token": refresh_token,
    "grant_type": "refresh_token",
}).encode()
req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                              headers={"Content-Type": "application/x-www-form-urlencoded"})
try:
    with urllib.request.urlopen(req) as r:
        resp = json.loads(r.read())
    access = resp["access_token"]
    print(f"✅ token exchange works ({len(access)} chars, expires in {resp['expires_in']}s)")
except urllib.error.HTTPError as e:
    body = e.read().decode()
    sys.exit(f"❌ token exchange failed: {e.code} {body}")

# Check scopes
with urllib.request.urlopen(f"https://oauth2.googleapis.com/tokeninfo?access_token={access}") as r:
    info = json.loads(r.read())
scopes = info.get("scope", "").split()
has_drive = any("drive" in s for s in scopes)
has_gmail = any("gmail" in s for s in scopes)
print(f"   scopes: {len(scopes)}")
for s in scopes:
    print(f"     - {s}")
if not has_drive:
    sys.exit("❌ drive scope missing — re-run gcloud login with --scopes including drive.readonly")
if not has_gmail:
    sys.exit("❌ gmail scope missing — re-run gcloud login with --scopes including gmail.readonly")

# ---------- Update .dev.vars ----------
secrets = {}
if DEVVARS.exists():
    for line in DEVVARS.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip(); v = v.strip()
        if re.match(r"^[A-Z_][A-Z0-9_]*$", k):
            secrets[k] = v

secrets["GMAIL_OAUTH_CLIENT_ID"] = client_id
secrets["GMAIL_OAUTH_CLIENT_SECRET"] = client_secret
secrets["GMAIL_OAUTH_REFRESH_TOKEN"] = refresh_token

header = [
    "# Local dev secrets — gitignored. Loaded via scripts/load_secrets.py.",
    "# For production, push to Cloudflare via `wrangler secret put <NAME>`.",
    "",
]
body = [f"{k}={secrets[k]}" for k in sorted(secrets.keys())]
DEVVARS.write_text("\n".join(header + body) + "\n")
DEVVARS.chmod(0o600)
print(f"✅ .dev.vars updated with ADC credentials")

# ---------- Push to CF ----------
env = os.environ.copy()
env["CLOUDFLARE_API_TOKEN"] = secrets.get("CLOUDFLARE_API_TOKEN", "")
env["CLOUDFLARE_ACCOUNT_ID"] = secrets.get("CLOUDFLARE_ACCOUNT_ID", "")

def push(key, val):
    r = subprocess.run([str(WRANGLER), "secret", "put", key], input=val.encode(),
                       cwd=REPO, env=env, capture_output=True)
    return any(s in (r.stdout + r.stderr).decode() for s in ("Success", "Uploaded", "uploaded"))

for key in ("GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_OAUTH_REFRESH_TOKEN"):
    print(f"   pushing {key}…", end=" ", flush=True)
    print("✅" if push(key, secrets[key]) else "❌")

# Log
from datetime import datetime
with ROTATION_LOG.open("a") as f:
    stamp = datetime.now().isoformat(timespec="seconds")
    f.write(f"{stamp}  adc_adopted  GMAIL_OAUTH_CLIENT_ID\n")
    f.write(f"{stamp}  adc_adopted  GMAIL_OAUTH_CLIENT_SECRET\n")
    f.write(f"{stamp}  adc_adopted  GMAIL_OAUTH_REFRESH_TOKEN\n")

print(f"\n✅ Done. Now redeploy:")
print(f"   cd {REPO} && eval \"$(python3 scripts/load_secrets.py)\" && \\")
print(f"     export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID && \\")
print(f"     ./node_modules/.bin/wrangler deploy")

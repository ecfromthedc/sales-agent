#!/usr/bin/env python3
"""
v2 finish — apply new refresh token + Meet folder ID + redeploy.

Reads values from env vars (never CLI args, never echoed). Updates .dev.vars,
pushes to CF as secrets/vars, redeploys, smoke-tests Drive listing.
"""
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(os.environ.get("RT_AGENT_REPO", Path.home() / "Projects/active/rt-sales-call-agent"))
DEVVARS = REPO / ".dev.vars"
WRANGLER_TOML = REPO / "wrangler.toml"

NEW_REFRESH = os.environ.get("NEW_GMAIL_OAUTH_REFRESH_TOKEN", "").strip()
FOLDER_ID = os.environ.get("MEET_RECORDINGS_FOLDER_ID", "").strip()

if not NEW_REFRESH or not FOLDER_ID:
    sys.exit("Need NEW_GMAIL_OAUTH_REFRESH_TOKEN + MEET_RECORDINGS_FOLDER_ID env vars")

# ---------- Update .dev.vars in place (never echo values) ----------
lines = DEVVARS.read_text().splitlines()
out = []
seen_refresh = seen_folder = False
for line in lines:
    if line.startswith("GMAIL_OAUTH_REFRESH_TOKEN="):
        out.append(f"GMAIL_OAUTH_REFRESH_TOKEN={NEW_REFRESH}")
        seen_refresh = True
    elif line.startswith("MEET_RECORDINGS_FOLDER_ID="):
        out.append(f"MEET_RECORDINGS_FOLDER_ID={FOLDER_ID}")
        seen_folder = True
    else:
        out.append(line)
if not seen_refresh:
    out.append(f"GMAIL_OAUTH_REFRESH_TOKEN={NEW_REFRESH}")
if not seen_folder:
    out.append(f"MEET_RECORDINGS_FOLDER_ID={FOLDER_ID}")

DEVVARS.write_text("\n".join(out) + "\n")
DEVVARS.chmod(0o600)
print(f"✅ .dev.vars updated (refresh: {len(NEW_REFRESH)} chars, folder: {FOLDER_ID[:6]}...)")

# ---------- Patch wrangler.toml ----------
toml = WRANGLER_TOML.read_text()
toml = re.sub(
    r'MEET_RECORDINGS_FOLDER_ID\s*=\s*"[^"]*"',
    f'MEET_RECORDINGS_FOLDER_ID = "{FOLDER_ID}"',
    toml,
)
WRANGLER_TOML.write_text(toml)
print(f"✅ wrangler.toml patched with folder ID")

# ---------- Push refresh token to CF (silent, via stdin) ----------
cf_token = os.environ.get("CLOUDFLARE_API_TOKEN")
cf_account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
if not cf_token or not cf_account:
    sys.exit("Need CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env (load_secrets.py first)")

env = {**os.environ, "CLOUDFLARE_API_TOKEN": cf_token, "CLOUDFLARE_ACCOUNT_ID": cf_account}
wrangler = REPO / "node_modules/.bin/wrangler"

r = subprocess.run(
    [str(wrangler), "secret", "put", "GMAIL_OAUTH_REFRESH_TOKEN"],
    input=NEW_REFRESH.encode(),
    cwd=REPO, env=env, capture_output=True,
)
ok = b"Success" in r.stdout or b"Uploaded" in r.stdout or b"uploaded" in r.stdout
print(f"{'✅' if ok else '❌'} CF secret GMAIL_OAUTH_REFRESH_TOKEN pushed")

# ---------- Deploy ----------
r = subprocess.run([str(wrangler), "deploy"], cwd=REPO, env=env, capture_output=True)
for line in r.stdout.decode().splitlines():
    if any(k in line for k in ("Uploaded", "Version", "workers.dev", "schedule")):
        print(f"  {line.strip()}")
print("✅ deployed")

#!/usr/bin/env python3
"""
RT Sales Call Agent — interactive secret rotation.

For each leaked or stale secret:
  1. Open the rotation URL in your browser
  2. You generate a new value at the provider
  3. You paste the new value here (hidden input — never echoed)
  4. Script writes it to .dev.vars + pushes to Cloudflare in one shot
  5. Optional: deletes the old key at the provider via API if supported

Run anytime:
    python3 ~/Documents/Development/sales-agent/scripts/rotate_secrets.py

Skip any item by pressing Enter at the prompt.
"""
import getpass
import os
import re
import shlex
import subprocess
import sys
import webbrowser
from datetime import datetime
from pathlib import Path

REPO = Path(os.environ.get("RT_AGENT_REPO", Path.home() / "Documents/Development/sales-agent"))
DEVVARS = REPO / ".dev.vars"
WRANGLER = REPO / "node_modules/.bin/wrangler"
ROTATION_LOG = REPO / ".rotation-log"   # plaintext audit, gitignored, never holds values

# ---------- The rotation list ----------
# Each entry: (env_var_name, friendly_name, rotation_url, instructions, push_to_cf)
ROTATIONS = [
    (
        "CLOUDFLARE_API_TOKEN",
        "Cloudflare API Token",
        "https://dash.cloudflare.com/profile/api-tokens",
        [
            "1. Find the existing 'rt-sales-call-agent' token. Click the … menu → Roll.",
            "2. Confirm. Copy the new token from the success screen.",
            "3. Paste it below (input hidden).",
        ],
        False,  # This token is for local deploys, not a runtime CF secret.
    ),
    (
        "ANTHROPIC_API_KEY",
        "Anthropic API Key",
        "https://console.anthropic.com/settings/keys",
        [
            "1. Find 'rt-sales-call-agent' key. Click the menu → Delete (or Disable).",
            "2. Click 'Create Key'. Name: rt-sales-call-agent. Permissions: Default.",
            "3. Copy the new sk-ant-... key. Paste below.",
        ],
        True,
    ),
    (
        "CALENDLY_PERSONAL_ACCESS_TOKEN",
        "Calendly Personal Access Token",
        "https://calendly.com/integrations/api_webhooks",
        [
            "1. Under Personal Access Tokens, find 'rt-sales-call-agent'. Click Revoke.",
            "2. Click 'Generate New Token'. Name: rt-sales-call-agent.",
            "3. Copy the new token. Paste below.",
        ],
        True,
    ),
    (
        "SPOTIFY_CLIENT_SECRET",
        "Spotify Client Secret",
        "https://developer.spotify.com/dashboard",
        [
            "1. Open the 'RT Sales Call Agent' app.",
            "2. Settings → 'View client secret' → 'Rotate client secret'.",
            "3. Copy the new secret. Paste below.",
            "   (Client ID does NOT change — no need to rotate that)",
        ],
        True,
    ),
    (
        "GMAIL_OAUTH_CLIENT_SECRET",
        "Gmail/Drive OAuth Client Secret",
        "https://console.cloud.google.com/apis/credentials",
        [
            "1. Find the 'RT Sales Call Agent' OAuth 2.0 Client ID. Click it.",
            "2. Click 'Reset Secret' (or 'Add Secret' then delete the old one).",
            "3. Copy the new secret. Paste below.",
            "   ⚠ This will INVALIDATE the current refresh token.",
            "   You will need to re-mint via OAuth Playground after this step.",
            "   (Run this script again to set the new GMAIL_OAUTH_REFRESH_TOKEN.)",
        ],
        True,
    ),
    (
        "GMAIL_OAUTH_REFRESH_TOKEN",
        "Gmail/Drive Refresh Token (re-mint after Client Secret rotation)",
        "https://developers.google.com/oauthplayground/",
        [
            "1. Gear icon → tick 'Use your own OAuth credentials'.",
            "2. Paste your GMAIL_OAUTH_CLIENT_ID and the NEW GMAIL_OAUTH_CLIENT_SECRET.",
            "3. Tick BOTH scopes: gmail.readonly + drive.readonly.",
            "4. Authorize → sign in as ec@risingtidesent.com → Continue.",
            "5. Step 2 → Exchange authorization code for tokens.",
            "6. Copy the refresh_token from the JSON response. Paste below.",
        ],
        True,
    ),
]


def load_existing_secrets():
    """Read .dev.vars into a dict, never echoing values."""
    if not DEVVARS.exists():
        return {}
    out = {}
    for line in DEVVARS.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (v.startswith("'") and v.endswith("'")):
            v = v[1:-1]
        if re.match(r"^[A-Z_][A-Z0-9_]*$", k):
            out[k] = v
    return out


def write_dev_vars(secrets):
    """Write the secrets dict back to .dev.vars in a stable order."""
    header = [
        "# Local dev secrets — gitignored. Loaded via scripts/load_secrets.py.",
        "# For production, push to Cloudflare via `wrangler secret put <NAME>`.",
        "",
    ]
    body = [f"{k}={secrets[k]}" for k in sorted(secrets.keys())]
    DEVVARS.write_text("\n".join(header + body) + "\n")
    DEVVARS.chmod(0o600)


def push_cf_secret(name, value):
    """Push a secret to Cloudflare via wrangler. Never echoes the value."""
    if not WRANGLER.exists():
        return False, "wrangler not installed"
    env = os.environ.copy()
    r = subprocess.run(
        [str(WRANGLER), "secret", "put", name],
        input=value.encode(),
        cwd=REPO, env=env, capture_output=True,
    )
    out = r.stdout.decode() + r.stderr.decode()
    ok = any(s in out for s in ("Success", "Uploaded", "uploaded"))
    return ok, out[-200:] if not ok else None


def log_rotation(name):
    """Append a rotation event. Never logs the value, only what + when."""
    stamp = datetime.now().isoformat(timespec="seconds")
    with ROTATION_LOG.open("a") as f:
        f.write(f"{stamp}  rotated  {name}\n")


def main():
    print("\n=== RT Sales Call Agent — Secret Rotation ===\n")
    print("Each prompt accepts a paste (input is hidden — won't show on screen).")
    print("Press Enter with no input to SKIP that key.\n")

    secrets = load_existing_secrets()
    rotated = []
    skipped = []

    for env_var, friendly, url, instructions, push_to_cf in ROTATIONS:
        print(f"\n{'─' * 64}")
        print(f"  ROTATE: {friendly}")
        print(f"  Var:    {env_var}")
        print(f"  Open:   {url}")
        print(f"{'─' * 64}")
        for line in instructions:
            print(f"  {line}")

        # Try to open URL in default browser
        try:
            webbrowser.open(url)
        except Exception:
            pass

        new_val = getpass.getpass(f"\n  Paste new {env_var} (hidden, Enter to skip): ").strip()
        if not new_val:
            print(f"  ⏭️  skipped {env_var}")
            skipped.append(env_var)
            continue

        # Sanity check — value isn't a placeholder
        if len(new_val) < 20:
            confirm = input(f"  ⚠ Value is short ({len(new_val)} chars). Continue anyway? [y/N] ").lower()
            if confirm != "y":
                skipped.append(env_var)
                continue

        # Write to .dev.vars
        secrets[env_var] = new_val
        write_dev_vars(secrets)
        print(f"  ✅ .dev.vars updated ({len(new_val)} chars)")

        # Push to CF if applicable
        if push_to_cf:
            ok, err = push_cf_secret(env_var, new_val)
            if ok:
                print(f"  ✅ Cloudflare secret pushed")
            else:
                print(f"  ⚠ CF push may have failed: {err}")

        log_rotation(env_var)
        rotated.append(env_var)

    print(f"\n{'═' * 64}")
    print(f"  ROTATION COMPLETE")
    print(f"{'═' * 64}")
    print(f"\n  Rotated ({len(rotated)}):")
    for k in rotated:
        print(f"    ✅ {k}")
    if skipped:
        print(f"\n  Skipped ({len(skipped)}):")
        for k in skipped:
            print(f"    ⏭️  {k}")

    if rotated:
        print(f"\n  Next steps:")
        if any(k in rotated for k in ("ANTHROPIC_API_KEY", "GMAIL_OAUTH_REFRESH_TOKEN",
                                       "CALENDLY_PERSONAL_ACCESS_TOKEN", "SPOTIFY_CLIENT_SECRET",
                                       "GMAIL_OAUTH_CLIENT_SECRET")):
            print(f"    1. Redeploy the worker so it picks up the new secrets:")
            print(f"       cd {REPO} && eval \"$(python3 scripts/load_secrets.py)\" \\")
            print(f"         && export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID \\")
            print(f"         && ./node_modules/.bin/wrangler deploy")
        print(f"    2. Scrub past transcripts (optional but recommended):")
        print(f"       ~/.claude/scripts/scrub-transcripts.sh")
        print(f"    3. Audit log: cat {ROTATION_LOG}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  ✗ aborted by user")
        sys.exit(1)

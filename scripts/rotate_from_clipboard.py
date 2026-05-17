#!/usr/bin/env python3
"""
Rotate a single secret by reading its new value from the macOS clipboard.

Workflow:
  1. Chrome agent generates the new credential on the provider's site.
  2. New value is on clipboard (Cmd+C or provider's "Copy" button).
  3. You run: python3 scripts/rotate_from_clipboard.py <KEY_NAME>
  4. Script reads pbpaste, validates, writes .dev.vars, pushes to CF, clears
     clipboard so the value doesn't linger.

The value never appears on stdout, never gets echoed by the shell, never
flows through any Claude context.

Usage:
  python3 scripts/rotate_from_clipboard.py CLOUDFLARE_API_TOKEN
  python3 scripts/rotate_from_clipboard.py ANTHROPIC_API_KEY
  python3 scripts/rotate_from_clipboard.py CALENDLY_PERSONAL_ACCESS_TOKEN
  python3 scripts/rotate_from_clipboard.py SPOTIFY_CLIENT_SECRET
  python3 scripts/rotate_from_clipboard.py GMAIL_OAUTH_CLIENT_SECRET
  python3 scripts/rotate_from_clipboard.py GMAIL_OAUTH_REFRESH_TOKEN
"""
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO = Path(os.environ.get("RT_AGENT_REPO", Path.home() / "Projects/active/rt-sales-call-agent"))
DEVVARS = REPO / ".dev.vars"
WRANGLER = REPO / "node_modules/.bin/wrangler"
ROTATION_LOG = REPO / ".rotation-log"

# Which keys also need to be pushed to Cloudflare as runtime secrets.
# CLOUDFLARE_API_TOKEN is used only for deploys, so it stays local-only.
PUSH_TO_CF = {
    "ANTHROPIC_API_KEY",
    "CALENDLY_PERSONAL_ACCESS_TOKEN",
    "SPOTIFY_CLIENT_SECRET",
    "GMAIL_OAUTH_CLIENT_SECRET",
    "GMAIL_OAUTH_REFRESH_TOKEN",
}

VALID_KEYS = PUSH_TO_CF | {"CLOUDFLARE_API_TOKEN"}

# Format sanity checks per key — catches "paste wrong thing" mistakes early.
PREFIXES = {
    "ANTHROPIC_API_KEY":           ("sk-ant-", 80),
    "CLOUDFLARE_API_TOKEN":        (None, 35),
    "GMAIL_OAUTH_CLIENT_SECRET":   ("GOCSPX-", 25),
    "GMAIL_OAUTH_REFRESH_TOKEN":   ("1//", 80),
    "SPOTIFY_CLIENT_SECRET":       (None, 25),
    "CALENDLY_PERSONAL_ACCESS_TOKEN": ("eyJ", 200),
}


def read_clipboard() -> str:
    try:
        r = subprocess.run(["pbpaste"], capture_output=True, timeout=2)
        return r.stdout.decode("utf-8", errors="replace").strip()
    except FileNotFoundError:
        sys.exit("❌ pbpaste not found (macOS only)")


def clear_clipboard() -> None:
    try:
        subprocess.run(["pbcopy"], input=b"", timeout=2)
    except Exception:
        pass


def load_dev_vars() -> dict:
    out = {}
    if not DEVVARS.exists():
        return out
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


def write_dev_vars(secrets: dict) -> None:
    header = [
        "# Local dev secrets — gitignored. Loaded via scripts/load_secrets.py.",
        "# For production, push to Cloudflare via `wrangler secret put <NAME>`.",
        "",
    ]
    body = [f"{k}={secrets[k]}" for k in sorted(secrets.keys())]
    DEVVARS.write_text("\n".join(header + body) + "\n")
    DEVVARS.chmod(0o600)


def push_cf(key: str, value: str) -> bool:
    if not WRANGLER.exists():
        print(f"  ⚠ wrangler binary not found — run `npm install` first")
        return False
    env = os.environ.copy()
    # Make sure CF deploy creds are present in env
    if "CLOUDFLARE_API_TOKEN" not in env or "CLOUDFLARE_ACCOUNT_ID" not in env:
        secrets = load_dev_vars()
        env["CLOUDFLARE_API_TOKEN"] = secrets.get("CLOUDFLARE_API_TOKEN", "")
        env["CLOUDFLARE_ACCOUNT_ID"] = secrets.get("CLOUDFLARE_ACCOUNT_ID", "")
    r = subprocess.run(
        [str(WRANGLER), "secret", "put", key],
        input=value.encode(),
        cwd=REPO, env=env, capture_output=True,
    )
    out = (r.stdout + r.stderr).decode()
    return any(s in out for s in ("Success", "Uploaded", "uploaded"))


def log_rotation(key: str) -> None:
    stamp = datetime.now().isoformat(timespec="seconds")
    with ROTATION_LOG.open("a") as f:
        f.write(f"{stamp}  rotated  {key}\n")


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: rotate_from_clipboard.py <KEY_NAME>")
    key = sys.argv[1]
    if key not in VALID_KEYS:
        sys.exit(f"❌ unknown key: {key}\n   valid: {', '.join(sorted(VALID_KEYS))}")

    val = read_clipboard()
    if not val:
        sys.exit("❌ clipboard is empty. Copy the new value first, then re-run.")

    # Sanity checks
    prefix, min_len = PREFIXES.get(key, (None, 20))
    if len(val) < min_len:
        sys.exit(f"❌ value is only {len(val)} chars (expected ≥ {min_len}). Wrong thing on clipboard?")
    if prefix and not val.startswith(prefix):
        confirm = input(f"⚠ value doesn't start with '{prefix}' (got '{val[:8]}...'). Continue? [y/N] ").lower()
        if confirm != "y":
            sys.exit("aborted")

    # Write .dev.vars
    secrets = load_dev_vars()
    secrets[key] = val
    write_dev_vars(secrets)
    print(f"✅ .dev.vars updated ({key}, {len(val)} chars)")

    # Push to CF if applicable
    if key in PUSH_TO_CF:
        if push_cf(key, val):
            print(f"✅ Cloudflare secret pushed ({key})")
        else:
            print(f"⚠ CF push failed — value is still in .dev.vars; retry with: wrangler secret put {key}")

    log_rotation(key)
    clear_clipboard()
    print(f"✅ clipboard cleared")
    print(f"   {ROTATION_LOG.name} appended")


if __name__ == "__main__":
    main()

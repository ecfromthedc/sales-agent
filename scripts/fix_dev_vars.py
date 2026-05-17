#!/usr/bin/env python3
"""
Repair common .dev.vars formatting issues without printing secret values.

Fixes:
  1. Strips leading/trailing whitespace around values.
  2. Renames `Cloudflare=` to `CLOUDFLARE_API_TOKEN=`.
  3. Renames `CALENDLY_WEBHOOK_SIGNING_KEY=` to `CALENDLY_PERSONAL_ACCESS_TOKEN=`
     IF the value is suspiciously long (>200 chars) — the real signing key is short
     and only exists after we create the webhook subscription.
  4. Extracts a CLOUDFLARE_ACCOUNT_ID from any stray narrative line.
  5. Drops orphan English-text lines that aren't key=value.
  6. Adds a placeholder `NOTION_API_KEY=` line if missing, sourcing from $NOTION_API_TOKEN.
  7. Removes GRANOLA_WEBHOOK_SIGNING_KEY (we replaced Granola with Drive watch).
  8. Adds GMAIL_OAUTH_REDIRECT_URI for the Gmail/Drive token refresh.

Prints only key NAMES and a summary of what changed. Never echoes values.
"""
import os
import re
import shutil
from pathlib import Path

PATH = Path.home() / "Projects/active/rt-sales-call-agent/.dev.vars"
BACKUP = PATH.with_suffix(".dev.vars.bak")

RENAMES = {
    "Cloudflare": "CLOUDFLARE_API_TOKEN",
}

DROP_KEYS = {"GRANOLA_WEBHOOK_SIGNING_KEY"}

# 24-char hex Cloudflare account IDs in narrative lines look like d5fbf64067844a591842c14f1b53bd79
ACCOUNT_ID_RE = re.compile(r"\b[a-f0-9]{32}\b")


def main():
    if not PATH.exists():
        print(f"{PATH} not found")
        return

    shutil.copy(PATH, BACKUP)
    raw = PATH.read_text().splitlines()

    parsed = {}        # KEY -> value
    extracted = {}     # what we inferred from narrative
    preserved_comments = []

    for line in raw:
        line = line.rstrip()
        if not line:
            continue
        if line.startswith("#"):
            preserved_comments.append(line)
            continue

        if "=" in line:
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip()
            if key in DROP_KEYS:
                continue
            key = RENAMES.get(key, key)
            if key and re.match(r"^[A-Z][A-Z0-9_]*$", key):
                parsed[key] = val
                continue

        # Not a clean key=value line. Try to extract an account ID from narrative.
        m = ACCOUNT_ID_RE.search(line)
        if m:
            extracted["CLOUDFLARE_ACCOUNT_ID"] = m.group(0)
        # otherwise discard silently — was likely pasted narrative text

    # Heuristic: if CALENDLY_WEBHOOK_SIGNING_KEY has a suspiciously long value, it's
    # actually the PAT. Rename it. The real signing key only comes back from POST /webhook_subscriptions.
    if "CALENDLY_WEBHOOK_SIGNING_KEY" in parsed and len(parsed["CALENDLY_WEBHOOK_SIGNING_KEY"]) > 200:
        parsed["CALENDLY_PERSONAL_ACCESS_TOKEN"] = parsed.pop("CALENDLY_WEBHOOK_SIGNING_KEY")
        parsed.setdefault("CALENDLY_WEBHOOK_SIGNING_KEY", "")

    # Merge extracted values without overwriting explicit ones.
    for k, v in extracted.items():
        parsed.setdefault(k, v)

    # Backfill NOTION_API_KEY from the shell env if it's empty.
    if not parsed.get("NOTION_API_KEY"):
        shell_token = os.environ.get("NOTION_API_TOKEN", "")
        if shell_token:
            parsed["NOTION_API_KEY"] = shell_token

    # Required keys (ensure they exist, even if empty, so format is consistent).
    required = [
        "ANTHROPIC_API_KEY",
        "NOTION_API_KEY",
        "SPOTIFY_CLIENT_ID",
        "SPOTIFY_CLIENT_SECRET",
        "GMAIL_OAUTH_CLIENT_ID",
        "GMAIL_OAUTH_CLIENT_SECRET",
        "GMAIL_OAUTH_REFRESH_TOKEN",
        "GMAIL_OAUTH_REDIRECT_URI",
        "MEET_RECORDINGS_FOLDER_ID",
        "CALENDLY_PERSONAL_ACCESS_TOKEN",
        "CALENDLY_WEBHOOK_SIGNING_KEY",
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "TIDES_TRACKER_API_KEY",
    ]
    for k in required:
        parsed.setdefault(k, "")

    # Sensible default for redirect URI used during refresh-token mint.
    if not parsed["GMAIL_OAUTH_REDIRECT_URI"]:
        parsed["GMAIL_OAUTH_REDIRECT_URI"] = "https://developers.google.com/oauthplayground"

    # Write back, sorted by key for stable diffs.
    lines = [
        "# Local dev secrets — gitignored. Loaded by `wrangler dev` automatically.",
        "# For production, push to Cloudflare via `wrangler secret put <NAME>`.",
        "",
    ]
    for k in required:
        lines.append(f"{k}={parsed[k]}")

    # Any extra keys not in the required list, appended at the end.
    extras = sorted(set(parsed) - set(required))
    if extras:
        lines.append("")
        lines.append("# extras")
        for k in extras:
            lines.append(f"{k}={parsed[k]}")

    PATH.write_text("\n".join(lines) + "\n")
    PATH.chmod(0o600)

    # Report (NAMES ONLY, no values)
    print("=== .dev.vars after repair ===")
    for k in required:
        v = parsed[k]
        status = f"set ({len(v)} chars)" if v else "EMPTY"
        print(f"  {k:<40} {status}")
    if extras:
        print("  --- extras ---")
        for k in extras:
            v = parsed[k]
            status = f"set ({len(v)} chars)" if v else "EMPTY"
            print(f"  {k:<40} {status}")
    print(f"\nbackup saved at {BACKUP}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Safe secrets emitter. Reads .dev.vars and prints shell-quoted `export` lines.
Never echoes raw values to stderr or terminal.

Usage in zsh/bash:
    eval "$(python3 ~/Projects/active/rt-sales-call-agent/scripts/load_secrets.py)"

Skips malformed lines silently. Won't let bash interpret values as commands.
"""
import os
import re
import shlex
import sys
from pathlib import Path

repo = Path(os.environ.get("RT_AGENT_REPO", Path.home() / "Projects/active/rt-sales-call-agent"))
path = repo / ".dev.vars"

if not path.exists():
    print(f"echo 'load_secrets: {path} not found' >&2", file=sys.stdout)
    sys.exit(0)

key_re = re.compile(r"^[A-Z_][A-Z0-9_]*$")

for raw in path.read_text().splitlines():
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if "=" not in line:
        continue
    key, _, val = line.partition("=")
    key = key.strip()
    val = val.strip()
    # Strip surrounding quotes if present
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        val = val[1:-1]
    if not key_re.match(key):
        continue
    print(f"export {key}={shlex.quote(val)}")

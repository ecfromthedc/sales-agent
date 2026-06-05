#!/usr/bin/env bash
# Cron entrypoint. PAUSED by default: does nothing unless scripts/loop/ACTIVE exists.
set -euo pipefail
cd "$(dirname "$0")/../.."
TS=$(date "+%Y-%m-%dT%H:%M:%S")
if [ ! -f scripts/loop/ACTIVE ]; then echo "$TS loop paused (no ACTIVE flag)" >> logs/loop.log; exit 0; fi
{
  echo "=== $TS build ==="; python3 scripts/loop/sale_loop.py build
  echo "=== $TS review ==="; python3 scripts/loop/sale_loop.py review
} >> logs/loop.log 2>&1

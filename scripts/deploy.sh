#!/usr/bin/env bash
# End-to-end deploy. Reads .dev.vars, never echoes secret values.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
DEVVARS="$REPO/.dev.vars"

[[ -f "$DEVVARS" ]] || { echo "ERROR: $DEVVARS not found"; exit 1; }

# Load .dev.vars without leaking — only export, never print values.
set -a
# shellcheck disable=SC1090
source "$DEVVARS"
set +a

require() {
  local name="$1"
  local val
  val="$(eval echo \$$name)"
  if [[ -z "$val" ]]; then
    echo "ERROR: $name is empty in .dev.vars"
    exit 1
  fi
}

# Required to start
for k in ANTHROPIC_API_KEY NOTION_API_KEY SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET \
         GMAIL_OAUTH_CLIENT_ID GMAIL_OAUTH_CLIENT_SECRET GMAIL_OAUTH_REFRESH_TOKEN \
         CALENDLY_PERSONAL_ACCESS_TOKEN CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  require "$k"
done

export CLOUDFLARE_API_TOKEN
export CLOUDFLARE_ACCOUNT_ID

WRANGLER="$REPO/node_modules/.bin/wrangler"
[[ -x "$WRANGLER" ]] || { echo "ERROR: wrangler not installed; run 'npm install'"; exit 1; }

echo "=== [1/8] Verifying Cloudflare auth ==="
"$WRANGLER" whoami 2>&1 | tail -5

echo
echo "=== [2/8] Creating KV namespace (idempotent) ==="
KV_OUT=$("$WRANGLER" kv namespace create rt_sales_state 2>&1 || true)
echo "$KV_OUT" | grep -v -i "token\|secret\|key:" || true
# Extract id from output like:  id = "abcd1234..."
KV_ID=$(echo "$KV_OUT" | grep -Eo 'id = "[a-f0-9]+"' | head -1 | sed -E 's/.*"([a-f0-9]+)".*/\1/')
if [[ -z "$KV_ID" ]]; then
  # Already exists — list and find it.
  KV_ID=$("$WRANGLER" kv namespace list 2>/dev/null | python3 -c "
import json,sys
ns=json.load(sys.stdin)
for n in ns:
  if n.get('title','').endswith('rt_sales_state'):
    print(n['id']); break
" || true)
fi
if [[ -z "$KV_ID" ]]; then
  echo "ERROR: could not create or find KV namespace rt_sales_state — aborting before toml patch" >&2
  exit 1
fi
echo "KV namespace id: $KV_ID"

echo
echo "=== [3/8] Creating R2 bucket (idempotent) ==="
"$WRANGLER" r2 bucket create rt-sales-pitch-pdfs 2>&1 | tail -3 || true

echo
echo "=== [4/8] Patching wrangler.toml with KV id ==="
python3 - <<PY
import re
from pathlib import Path
p = Path("wrangler.toml")
text = p.read_text()
# Uncomment R2 + KV blocks and inject KV id.
text = text.replace(
    '# [[r2_buckets]]\n# binding = "PITCH_PDFS"\n# bucket_name = "rt-sales-pitch-pdfs"',
    '[[r2_buckets]]\nbinding = "PITCH_PDFS"\nbucket_name = "rt-sales-pitch-pdfs"',
)
text = text.replace(
    '# [[kv_namespaces]]\n# binding = "STATE"\n# id = ""',
    '[[kv_namespaces]]\nbinding = "STATE"\nid = "$KV_ID"',
)
# Make sure the id replacement got the real KV id even if format slightly differs.
text = re.sub(r'(binding = "STATE"\n\s*id = ")\$KV_ID(")', r'\1$KV_ID\2', text)
p.write_text(text)
print("patched")
PY

echo
echo "=== [5/8] Uncommenting env.ts bindings ==="
python3 - <<'PY'
from pathlib import Path
p = Path("src/lib/env.ts")
t = p.read_text()
# Uncomment STATE and PITCH_PDFS bindings.
t = t.replace("  // PITCH_PDFS: R2Bucket;", "  PITCH_PDFS: R2Bucket;")
t = t.replace("  // STATE: KVNamespace;", "  STATE: KVNamespace;")
p.write_text(t)
print("patched")
PY

# Remove the @ts-expect-error guards that were there for optional KV.
python3 - <<'PY'
from pathlib import Path
p = Path("src/triggers/transcript-poll.ts")
t = p.read_text()
t = t.replace(
    "  // @ts-expect-error optional binding\n  const kv = env.STATE as KVNamespace | undefined;",
    "  const kv: KVNamespace | undefined = env.STATE;"
)
p.write_text(t)
print("patched")
PY

echo
echo "=== [6/8] Pushing secrets to Cloudflare (values never printed) ==="
push_secret() {
  local name="$1"
  local val
  val="$(eval echo \$$name)"
  if [[ -z "$val" ]]; then
    echo "  skip $name (empty)"
    return
  fi
  printf '%s' "$val" | "$WRANGLER" secret put "$name" 2>&1 | grep -iE "success|uploaded|error" | sed "s/.*/  → $name: &/" || echo "  → $name: pushed"
}

for k in ANTHROPIC_API_KEY NOTION_API_KEY SPOTIFY_CLIENT_ID SPOTIFY_CLIENT_SECRET \
         GMAIL_OAUTH_CLIENT_ID GMAIL_OAUTH_CLIENT_SECRET GMAIL_OAUTH_REFRESH_TOKEN \
         CALENDLY_PERSONAL_ACCESS_TOKEN TIDES_TRACKER_API_KEY DEEPSEEK_API_KEY \
         CHARTMETRIC_REFRESH_TOKEN; do
  push_secret "$k"
done
# Placeholder for the Calendly webhook signing key — populated after subscription.
echo "placeholder" | "$WRANGLER" secret put CALENDLY_WEBHOOK_SIGNING_KEY >/dev/null 2>&1 || true
echo "  → CALENDLY_WEBHOOK_SIGNING_KEY: placeholder (updated post-subscribe)"

echo
echo "=== [7/8] Typecheck + Deploy ==="
"$REPO/node_modules/.bin/tsc" --noEmit
"$WRANGLER" deploy 2>&1 | tail -20

echo
echo "=== [8/8] Done. ==="
echo "Health check next:"
echo '  curl -sS https://rt-sales-call-agent.$( "$WRANGLER" subdomain 2>/dev/null | grep -oE "[a-z0-9-]+\\.workers\\.dev" | head -1 )/health'

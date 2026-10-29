#!/bin/bash
# Usage: scripts/audit/fetch_curl.sh <id> <url> <save-relative-to-data/raw>
# Used where Python requests rejects an incomplete server certificate chain but system curl verifies it (no -k; TLS verification stays on).
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; ID="$1"; URL="$2"; OUT="$ROOT/data/raw/$3"
mkdir -p "$(dirname "$OUT")"
TS=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
META=$(curl -sL -A "HarvestOutlook-data-audit/0.1" --max-time 60 -o "$OUT" -w '%{http_code}\t%{content_type}\t%{url_effective}' "$URL")
CODE=$(cut -f1 <<<"$META"); CT=$(cut -f2 <<<"$META"); FU=$(cut -f3 <<<"$META")
SHA=$(shasum -a 256 "$OUT" | cut -d' ' -f1); BYTES=$(wc -c <"$OUT" | tr -d ' ')
REC=$(printf '{"id":"%s","url":"%s","retrievedAt":"%s","status":%s,"finalUrl":"%s","contentType":"%s","bytes":%s,"sha256":"%s","savedAs":"data/raw/%s","via":"curl"}' "$ID" "$URL" "$TS" "${CODE:-null}" "$FU" "$CT" "$BYTES" "$SHA" "$3")
echo "$REC" >> "$ROOT/data/raw/fetch_log.jsonl"; echo "$REC"

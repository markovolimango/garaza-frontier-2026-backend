#!/usr/bin/env bash
# Sample REST requests with curl against a running backend. The token is read from the runtime
# file and passed in a header (never in the URL); it is not printed.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
URL="${COACH_URL:-http://127.0.0.1:8765}"
TOKEN_FILE="$COACH_DIR/.runtime/api_token"
[[ -r "$TOKEN_FILE" ]] || { echo "Start the backend first (it writes $TOKEN_FILE)." >&2; exit 1; }
AUTH="Authorization: Bearer $(cat "$TOKEN_FILE")"
show() { echo; echo "\$ $*"; }

show curl "$URL/health";                        curl -s "$URL/health"; echo
show curl -H "\$AUTH" "$URL/v1/capabilities";   curl -s -H "$AUTH" "$URL/v1/capabilities" | head -c 400; echo " ..."
show curl -X POST "$URL/v1/sessions" '{"label":"rehearsal","mic_source":"iphone","config":{"speech":{"target_wpm_max":160}}}'
SESSION=$(curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"label":"rehearsal","mic_source":"iphone","config":{"speech":{"target_wpm_max":160}}}' "$URL/v1/sessions")
echo "$SESSION" | head -c 300; echo " ..."
SID=$(echo "$SESSION" | sed -E 's/.*"session_id":"([^"]+)".*/\1/')
for action in start pause resume; do
  show curl -X POST "$URL/v1/sessions/$SID/$action"; curl -s -X POST -H "$AUTH" "$URL/v1/sessions/$SID/$action" | head -c 120; echo
done
show curl -X POST "$URL/v1/sessions/$SID/calibration/start" '{"duration_s":60}'
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' -d '{"duration_s":60}' "$URL/v1/sessions/$SID/calibration/start"; echo
show curl "$URL/v1/sessions/$SID/snapshot";     curl -s -H "$AUTH" "$URL/v1/sessions/$SID/snapshot" | head -c 300; echo " ..."
show curl "$URL/v1/sessions/$SID/events?after_cursor=0&limit=5"; curl -s -H "$AUTH" "$URL/v1/sessions/$SID/events?after_cursor=0&limit=5" | head -c 300; echo " ..."
show curl -X POST "$URL/v1/sessions/$SID/start  (invalid transition -> 409 error envelope)"
curl -s -X POST -H "$AUTH" "$URL/v1/sessions/$SID/start"; echo
show curl -X POST "$URL/v1/sessions/$SID/stop"; curl -s -X POST -H "$AUTH" "$URL/v1/sessions/$SID/stop" | head -c 120; echo
show curl "$URL/v1/sessions/$SID/summary?narrative=true"; curl -s -H "$AUTH" "$URL/v1/sessions/$SID/summary?narrative=true" | head -c 400; echo " ..."
show curl -X POST "$URL/v1/pairing-codes"; curl -s -X POST -H "$AUTH" "$URL/v1/pairing-codes"; echo
show curl -X POST "$URL/v1/stream-tickets"; curl -s -X POST -H "$AUTH" "$URL/v1/stream-tickets" | sed -E 's/"ticket":"[^"]+"/"ticket":"<redacted>"/'; echo

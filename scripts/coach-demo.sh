#!/usr/bin/env bash
# Complete hardware-free simulated session: starts a local backend if none is running, runs the
# scenario (x8 speed), prints coaching / heart / tracking events and the summary, stops what it started.
#   bash scripts/coach-demo.sh [--speed 1] [--export fixtures/simulated_session.jsonl]
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
URL="http://127.0.0.1:${COACH_PORT:-8765}"
STARTED=""
if ! curl -sf "$URL/health" >/dev/null 2>&1; then
  (cd "$COACH_DIR" && exec "$COACH_PY" -m coach serve --port "${COACH_PORT:-8765}" --log-level warning) &
  STARTED=$!
  trap '[[ -n "$STARTED" ]] && kill "$STARTED" 2>/dev/null || true' EXIT
  for _ in $(seq 1 50); do curl -sf "$URL/health" >/dev/null 2>&1 && break; sleep 0.2; done
fi
cd "$COACH_DIR"
"$COACH_PY" -m coach simulate --url "$URL" "$@"

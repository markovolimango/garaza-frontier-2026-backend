#!/usr/bin/env bash
# Camera tuning: live readout of the body measures (fast hands, moving around, arms crossed, hand at face,
# looking down) next to their thresholds, for the newest coach session. Without one it starts a "tune"
# session with services/coach/tuning.json that `vision/run.sh --camera N --coach` joins; saving the file
# restarts that session with the new thresholds. Extra arguments go to `python -m coach tune`:
#   bash scripts/coach-tune.sh [--tuning path.json] [--no-create] [--once] [--interval 0.5]
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
coach_require_venv
cd "$COACH_DIR"
exec "$COACH_PY" -m coach tune "$@"

#!/usr/bin/env bash
# Create/reuse services/coach/.venv, install the locked dependencies and run the tests.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
pick_python() {
  local p v
  [[ -n "${PYTHON:-}" ]] && { echo "$PYTHON"; return; }
  for v in 3.12 3.13 3.11; do
    for p in "$(command -v python$v 2>/dev/null || true)" "$HOME"/.local/share/uv/python/cpython-"$v".*/bin/python"$v"; do
      if [[ -n "$p" && -x "$p" ]]; then echo "$p"; return; fi
    done
  done
  return 1
}
if [[ ! -x "$COACH_PY" ]]; then
  BASE="$(pick_python)" || { echo "Python 3.11-3.13 not found (set PYTHON=/path/to/python3.12)." >&2; exit 1; }
  echo "Creating services/coach/.venv with $BASE"
  "$BASE" -m venv "$COACH_DIR/.venv"
  "$COACH_PY" -m pip install --quiet --upgrade pip
fi
"$COACH_PY" -m pip install --quiet --disable-pip-version-check -r "$COACH_DIR/requirements.txt" -c "$COACH_DIR/requirements.lock.txt"
"$COACH_PY" -m pip check
(cd "$COACH_DIR" && "$COACH_PY" -m pytest -q)
echo "Backend ready. Start it with: bash scripts/coach-serve.sh"

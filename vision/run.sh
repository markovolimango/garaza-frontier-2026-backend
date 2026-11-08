#!/usr/bin/env bash
# Start the vision app with the project environment, from any working directory.
#
#   bash vision/run.sh --list-cameras
#   bash vision/run.sh --camera 1 [--preview-only] [--model s] [--save-points] ...
#   bash vision/run.sh --doctor      environment diagnostics (works before setup, no camera)
#   bash vision/run.sh --selftest    model + inference checks on sample images (no camera)
#   bash vision/run.sh --camera 1 --coach [URL]   also stream poses to services/coach
#   bash vision/run.sh --help

set -euo pipefail

VISION_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_PY="$VISION_DIR/.venv/bin/python"

# From a Rosetta (x86_64) shell, start Python natively so torch can use MPS.
NATIVE=()
if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then NATIVE=(arch -arm64); fi

if [[ "${1:-}" == "--doctor" ]]; then
  shift
  if [[ -x "$VENV_PY" ]]; then
    exec ${NATIVE[@]+"${NATIVE[@]}"} "$VENV_PY" "$VISION_DIR/doctor.py" "$@"
  fi
  echo "vision/.venv not found; running the doctor with the system python3." >&2
  exec python3 "$VISION_DIR/doctor.py" "$@"
fi

if [[ ! -x "$VENV_PY" ]]; then
  echo "vision/.venv is missing. Run first: bash vision/setup.sh" >&2
  exit 1
fi

if [[ "${1:-}" == "--selftest" ]]; then
  shift
  exec ${NATIVE[@]+"${NATIVE[@]}"} "$VENV_PY" "$VISION_DIR/selftest.py" "$@"
fi

exec ${NATIVE[@]+"${NATIVE[@]}"} "$VENV_PY" "$VISION_DIR/app.py" "$@"

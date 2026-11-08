#!/usr/bin/env bash
# Reproducible setup of the vision module (macOS, Apple Silicon). Safe to run again.
#
#   bash vision/setup.sh             create or reuse vision/.venv, install the verified versions,
#                                    download yolo26n-pose.pt if missing, run the checks
#   bash vision/setup.sh --model s   additionally download and check yolo26s-pose.pt
#   bash vision/setup.sh --upgrade   re-resolve requirements.txt, run the checks, rewrite the lock file
#
# PYTHON=/path/to/python3.12 bash vision/setup.sh   chooses the interpreter used to create .venv.
# Only files inside vision/ are created (plus pip's normal download cache).

set -Eeuo pipefail

VISION_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$VISION_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
REQUIREMENTS="$VISION_DIR/requirements.txt"
LOCK="$VISION_DIR/requirements.lock.txt"

say()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf '\nSETUP FAILED: %s\n' "$*" >&2; exit 1; }
trap 'printf "\nSETUP FAILED near line %s (see the error above). Fix it and run: bash vision/setup.sh\n" "$LINENO" >&2' ERR

UPGRADE=0
EXTRA_MODEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --upgrade) UPGRADE=1 ;;
    --model)
      [[ $# -ge 2 && ( "$2" == "n" || "$2" == "s" ) ]] || die "--model expects n or s"
      EXTRA_MODEL="$2"; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# Under Rosetta (x86_64 shell on Apple Silicon) a universal2 Python would start as x86_64.
# Every Python call goes through native(), which forces the arm64 slice in that case.
ROSETTA=0
if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then ROSETTA=1; fi
native() {
  if [[ $ROSETTA -eq 1 ]]; then arch -arm64 "$@"; else "$@"; fi
}

# Prints "<version> <machine>"; succeeds only for a native arm64 Python 3.10-3.13.
python_ok() {
  native "$1" -c 'import platform, sys
v = sys.version_info
print("%d.%d.%d %s" % (v[0], v[1], v[2], platform.machine()))
sys.exit(0 if (3, 10) <= v[:2] <= (3, 13) and platform.machine() == "arm64" else 1)' 2>/dev/null
}

# Prints the first suitable interpreter, preferring 3.12. Never modifies system Python.
find_python() {
  local v p candidates=()
  for v in 3.12 3.13 3.11 3.10; do
    p="$(command -v "python$v" 2>/dev/null || true)"
    if [[ -n "$p" ]]; then candidates+=("$p"); fi
    candidates+=("/opt/homebrew/bin/python$v" "/Library/Frameworks/Python.framework/Versions/$v/bin/python$v")
    for p in "$HOME"/.local/share/uv/python/cpython-"$v".*-macos-aarch64-none/bin/python"$v"; do
      candidates+=("$p")
    done
  done
  p="$(command -v python3 2>/dev/null || true)"
  if [[ -n "$p" ]]; then candidates+=("$p"); fi
  for p in "${candidates[@]}"; do
    if [[ -x "$p" ]] && python_ok "$p" >/dev/null; then printf '%s' "$p"; return 0; fi
  done
  if command -v uv >/dev/null 2>&1; then
    # uv keeps its interpreters in the user's home; system Python stays untouched.
    uv python install 3.12 >&2 || true
    p="$(uv python find 3.12 2>/dev/null || true)"
    if [[ -n "$p" ]] && python_ok "$p" >/dev/null; then printf '%s' "$p"; return 0; fi
  fi
  return 1
}

write_lock() {
  local tmp="$LOCK.tmp"
  {
    echo "# Exact versions installed by vision/setup.sh that passed vision/selftest.py."
    echo "# Verified: $(date -u +%Y-%m-%dT%H:%M:%SZ), macOS $(sw_vers -productVersion) $(uname -m), Python ${VENV_INFO% *}"
    echo "# Regenerate with: bash vision/setup.sh --upgrade"
    native "$VENV_PY" -m pip --disable-pip-version-check freeze --all --exclude-editable | grep -v -i '^pip=='
  } > "$tmp"
  mv "$tmp" "$LOCK"
}

# Compares installed versions with the lock file; prints differences, fails if there are any.
lock_matches() {
  native "$VENV_PY" - "$LOCK" <<'PY'
import sys
from importlib import metadata

def norm(name):
    return name.lower().replace("_", "-").replace(".", "-")

pins = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].split(";", 1)[0].strip()
    if "==" in line and not line.startswith("-"):
        name, version = line.split("==", 1)
        pins[norm(name)] = version.split()[0].strip()
installed = {norm(d.metadata["Name"]): d.version for d in metadata.distributions() if d.metadata["Name"]}
diff = [f"{n}: installed {installed.get(n, 'missing')}, lock {v}" for n, v in sorted(pins.items())
        if installed.get(n) != v]
for line in diff:
    print("    " + line)
sys.exit(1 if diff else 0)
PY
}

say "Platform"
[[ "$(uname -s)" == "Darwin" ]] || die "this setup is for macOS (found $(uname -s))."
[[ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" == "1" ]] || die "an Apple Silicon (arm64) Mac is required."
info "macOS $(sw_vers -productVersion), $(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo 'Apple Silicon')"
if [[ $ROSETTA -eq 1 ]]; then
  info "Note: this shell runs under Rosetta; Python is started with 'arch -arm64' so it runs natively."
fi

say "Python environment: $VENV_DIR"
FRESH_VENV=0
if [[ -x "$VENV_PY" ]] && VENV_INFO="$(python_ok "$VENV_PY")"; then
  info "Reusing existing environment (Python $VENV_INFO)."
else
  if [[ -e "$VENV_DIR" ]]; then
    info "Existing .venv is not a working native arm64 Python 3.10-3.13; recreating it."
  fi
  if [[ -n "${PYTHON:-}" ]]; then
    python_ok "$PYTHON" >/dev/null || die "PYTHON=$PYTHON is not a native arm64 Python 3.10-3.13."
    BASE_PY="$PYTHON"
  else
    BASE_PY="$(find_python)" || die "no native arm64 Python 3.10-3.13 found. Install Python 3.12 (macOS 64-bit universal2) from https://www.python.org/downloads/macos/ (or: uv python install 3.12), then rerun or set PYTHON=/path/to/python3.12."
  fi
  info "Creating .venv with $BASE_PY ($(python_ok "$BASE_PY"))"
  native "$BASE_PY" -m venv --clear "$VENV_DIR"
  VENV_INFO="$(python_ok "$VENV_PY")" || die "the new .venv failed the interpreter check."
  native "$VENV_PY" -m pip --disable-pip-version-check install --quiet --upgrade pip
  FRESH_VENV=1
fi
PIP=(native "$VENV_PY" -m pip --disable-pip-version-check)
# The lock file carries no hashes today; if it ever does, install from it in hash-checking mode.
LOCK_HAS_HASHES=0
if [[ -f "$LOCK" ]] && grep -q -- '--hash=' "$LOCK"; then LOCK_HAS_HASHES=1; fi

if [[ $UPGRADE -eq 1 ]]; then
  MODE="upgrade"
  say "Installing the newest versions allowed by requirements.txt (--upgrade)"
  "${PIP[@]}" install --upgrade -r "$REQUIREMENTS"
elif [[ -f "$LOCK" ]]; then
  MODE="lock"
  say "Installing verified versions (requirements.txt pinned by requirements.lock.txt)"
  if [[ $LOCK_HAS_HASHES -eq 1 ]]; then
    "${PIP[@]}" install --require-hashes -r "$LOCK"
  elif [[ $FRESH_VENV -eq 1 ]]; then
    "${PIP[@]}" install -r "$REQUIREMENTS" -c "$LOCK"
  else
    "${PIP[@]}" install --quiet -r "$REQUIREMENTS" -c "$LOCK"
  fi
  if lock_matches; then
    info "Packages match the lock file."
  else
    die "installed packages differ from requirements.lock.txt (listed above). Recreate the environment: rm -rf vision/.venv && bash vision/setup.sh"
  fi
else
  MODE="resolve"
  say "Installing from requirements.txt (no lock file yet; first install can take a few minutes)"
  "${PIP[@]}" install -r "$REQUIREMENTS"
fi
"${PIP[@]}" check
if "${PIP[@]}" show opencv-python-headless >/dev/null 2>&1; then
  die "opencv-python-headless is installed next to opencv-python; remove it: $VENV_PY -m pip uninstall opencv-python-headless"
fi

say "Model download and checks without a camera (vision/selftest.py)"
SELFTEST_ARGS=()
if [[ -n "$EXTRA_MODEL" ]]; then SELFTEST_ARGS+=(--model "$EXTRA_MODEL"); fi
native "$VENV_PY" "$VISION_DIR/selftest.py" ${SELFTEST_ARGS[@]+"${SELFTEST_ARGS[@]}"}

if [[ "$MODE" == "lock" ]]; then
  info "requirements.lock.txt unchanged."
else
  write_lock
  info "Wrote requirements.lock.txt with the versions that passed the checks."
fi

VERSIONS="$(native "$VENV_PY" -c 'from importlib.metadata import version as v
print(", ".join(f"{p} {v(p)}" for p in ("torch", "torchvision", "ultralytics", "opencv-python", "numpy", "websockets", "httpx")))')"
say "Setup complete"
info "Python:   $VENV_PY (Python $VENV_INFO)"
info "Packages: $VERSIONS"
info "Model:    $VISION_DIR/models/yolo26n-pose.pt"
info "Next:     bash vision/run.sh --list-cameras"
info "          bash vision/run.sh --camera INDEX --preview-only"

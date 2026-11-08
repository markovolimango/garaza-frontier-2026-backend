#!/usr/bin/env bash
# Build and test the CoachKit Swift package on macOS with Command Line Tools (no Xcode required),
# run real Vision pose on sample photos, validate that output against the backend contract, and
# report Speech/TTS/Foundation Models availability. iOS/watchOS app targets need Xcode (project.yml).
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
APPLE="$COACH_ROOT/apple"
CLT=/Library/Developer/CommandLineTools/Library/Developer
TEST_FLAGS=(-Xswiftc -F -Xswiftc "$CLT/Frameworks" -Xlinker -F -Xlinker "$CLT/Frameworks"
            -Xlinker -rpath -Xlinker "$CLT/Frameworks" -Xlinker -rpath -Xlinker "$CLT/usr/lib")
cd "$APPLE"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/apple-check.XXXXXX")"
trap 'rm -rf "$LOG_DIR"' EXIT

# run_filtered PATTERN LOG CMD...: full output goes to LOG, matching lines are printed, and the
# command's own exit status is returned (on failure the log tail is shown). With set -e a failed
# build or test stops the script, so later steps never run stale binaries from an older build.
run_filtered() {
  local pattern="$1" log="$2"; shift 2
  local status=0
  "$@" >"$log" 2>&1 || status=$?
  grep -E "$pattern" "$log" || true
  if [[ $status -ne 0 ]]; then
    echo "FAILED (exit $status): $*" >&2
    tail -n 40 "$log" >&2
  fi
  return "$status"
}

echo "==> swift build (macOS)"
run_filtered "error:|warning:|Build complete" "$LOG_DIR/build.log" swift build
BIN="$(swift build --show-bin-path)"
echo "==> swift test (Swift Testing from Command Line Tools)"
if [[ -d "$CLT/Frameworks/Testing.framework" ]]; then
  run_filtered "error:|✘|Test run with" "$LOG_DIR/test.log" swift test "${TEST_FLAGS[@]}"
else
  run_filtered "error:|Executed|Test run with" "$LOG_DIR/test.log" swift test
fi
SAMPLES=()
for candidate in "$COACH_ROOT"/vision/.venv/lib/python3*/site-packages/ultralytics/assets/{zidane,bus}.jpg; do
  [[ -f "$candidate" ]] && SAMPLES+=("$candidate")
done
if [[ ${#SAMPLES[@]} -gt 0 ]]; then
  echo "==> vision-probe on sample photos (real Vision on this Mac)"
  "$BIN/vision-probe" "${SAMPLES[@]}" --mode auto --repeat 5
  "$BIN/vision-probe" "${SAMPLES[@]}" --mode 2d --repeat 5
  if [[ -x "$COACH_PY" ]]; then
    echo "==> validate Swift/Vision JSON against the backend contract (PoseFramePayload)"
    { "$BIN/vision-probe" "${SAMPLES[@]}" --mode auto --repeat 1 --json
      "$BIN/vision-probe" "${SAMPLES[@]}" --mode 2d --repeat 1 --json; } |
      (cd "$COACH_DIR" && "$COACH_PY" -c '
import json, sys
from coach.wire import PoseFramePayload
lines = [l for l in sys.stdin if l.strip()]
for line in lines:
    payload = PoseFramePayload.model_validate(json.loads(line))
print(f"{len(lines)} Vision payloads valid against PoseFramePayload")')
  fi
else
  echo "(no sample photos found; run vision/setup.sh to get the Ultralytics samples, or pass your own to vision-probe)"
fi
echo "==> MacAssistant --check (TTS voices, Foundation Models availability; no audio)"
"$BIN/MacAssistant" --check | "${COACH_PY:-python3}" -c '
import json, sys
d = json.load(sys.stdin)
t, f = d["tts"], d["foundation_models"]
print("TTS: %s voices in %s languages; Serbian voices: %s" % (t["voices"], len(t["languages"]), t["serbian_voices"] or "none"))
print("Foundation Models: available=%s reason=%s supports=%s" % (f["available"], f.get("reason"), f.get("supportsLocale")))'

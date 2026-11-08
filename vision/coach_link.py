"""Optional link to the coach backend (services/coach): streams inferred poses as `pose.frame` events.

Wire contract: services/coach/coach/wire.py (EventIn envelope, PoseFramePayload, Joint2D) and
docs/api.md section 7 (/v1/ingest). The envelope mirrors coach.client.EventFactory.

- Pairing: on the same Mac the operator token is read from COACH_API_TOKEN or
  services/coach/.runtime/api_token (COACH_RUNTIME_DIR overrides the folder); a pairing code is
  created and exchanged for a device token automatically. For a remote backend pass a code
  (--coach-code) shown by `POST /v1/pairing-codes` on that machine.
- Handshake: Authorization header -> auth.ok, 5 clock.ping/clock.sample rounds, join (newest
  session that has not ended). Re-joins every JOIN_RETRY_S while there is no session or it ended.
- Pose frames are sent only while the session is `running`, at most pose_rate_hz per second
  (from the session control message, default 12). Sequence numbers are assigned at transmission
  and stay monotonic across app restarts: the next value is saved in vision/.runtime/ on exit and
  every SEQUENCE_SAVE_EVERY events (after a crash the app skips ahead by that many).
- The display/inference threads only call submit(), which never blocks: a small bounded queue
  keeps the newest frames and drops the oldest. All network I/O runs in one daemon thread.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import socket
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from pose_engine import KEYPOINT_NAMES, VISION_DIR

DEFAULT_COACH_URL = "http://127.0.0.1:8765"
REPO_DIR = VISION_DIR.parent
COACH_RUNTIME_DIR = REPO_DIR / "services" / "coach" / ".runtime"

DEFAULT_RATE_HZ = 12.0
QUEUE_SIZE = 4              # pose frames waiting for the sender thread; oldest dropped first
MAX_FRAME_AGE_S = 1.0       # older queued frames are dropped (server treats > 1.5 s as late)
JOIN_RETRY_S = 2.0
MAX_BATCH = 10
SEQUENCE_FILE = VISION_DIR / ".runtime" / "coach_sequence.json"
SEQUENCE_SAVE_EVERY = 100

# COCO-17 (Ultralytics order) -> wire joint names (Vision snake_case, anatomical left/right).
# The 17 COCO names are a subset of the 19 Vision 2D joints (Vision adds neck and root).
COCO_TO_WIRE = {name: name for name in KEYPOINT_NAMES}
WIRE_2D_NAMES = frozenset(COCO_TO_WIRE.values()) | {"neck", "root"}


def device_id_for_host() -> str:
    """Stable per-Mac id, e.g. mac-vision-1a2b3c4d5e (matches the contract's ID pattern)."""
    host = socket.gethostname() or "unknown"
    return "mac-vision-" + hashlib.sha256(host.encode("utf-8")).hexdigest()[:10]


def load_sequence(path: Path | None, device_id: str) -> int:
    """Next sequence number for this device. An unclean exit skips SEQUENCE_SAVE_EVERY ahead, so a
    restarted app never reuses numbers the backend already saw (that would be flagged out of order)."""
    if path is None:
        return 0
    try:
        entry = json.loads(path.read_text(encoding="utf-8")).get(device_id) or {}
        value = int(entry.get("next", 0))
    except (OSError, ValueError, AttributeError, TypeError):
        return 0
    return max(0, value) + (0 if entry.get("clean") else SEQUENCE_SAVE_EVERY)


def save_sequence(path: Path | None, device_id: str, value: int, clean: bool) -> None:
    if path is None:
        return
    try:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            data = data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            data = {}
        data[device_id] = {"next": value, "clean": clean}
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(path)
    except OSError:
        pass  # best effort: worst case the backend flags a few frames as out of order


def iso_utc(epoch_s: float) -> str:
    return datetime.fromtimestamp(epoch_s, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _person_score(person: dict) -> float:
    return sum(k["confidence"] for k in person["keypoints"] if k["valid"] and k["confidence"] is not None)


def build_pose_payload(people: list, width: int, height: int, *, model_name: str = "yolo26n-pose",
                       inference_ms: float | None = None, dropped_frames: int = 0) -> dict:
    """Map extract_people() output to a 2D PoseFramePayload (one person, like the iPhone app).

    Coordinates in the log/app are pixels of the unmirrored frame; the wire uses 0..1 with a
    top-left origin. Only keypoints marked valid are sent. With several detections the person with
    the largest summed valid-keypoint confidence is reported; persons_detected counts all of them.
    """
    payload = {
        "mode": "2d",
        "detector": f"ultralytics-{model_name}"[:64],
        "image": {"width": int(width), "height": int(height), "orientation": "up", "mirrored": False,
                  "camera_position": "external"},
        "persons_detected": min(len(people), 16),
        "tracking_state": "tracking" if people else "no_person",
        "dropped_frames_since_last": max(0, int(dropped_frames)),
        "coordinate_space_2d": "image_normalized_top_left",
    }
    if inference_ms is not None and math.isfinite(inference_ms):
        payload["inference_ms"] = round(max(0.0, inference_ms), 2)
    if not people:
        return payload
    best = max(people, key=_person_score)
    joints = []
    for point in best["keypoints"]:
        if not point["valid"]:
            continue
        joints.append({
            "name": COCO_TO_WIRE[point["name"]],
            "x": round(min(1.0, max(0.0, point["x"] / width)), 5),
            "y": round(min(1.0, max(0.0, point["y"] / height)), 5),
            "confidence": round(min(1.0, max(0.0, point["confidence"])), 4),
        })
    payload["joints_2d"] = joints
    if best.get("score") is not None:
        payload["observation_confidence"] = round(min(1.0, max(0.0, best["score"])), 4)
    return payload


def pose_payload_problems(payload: dict) -> list[str]:
    """Hand-written check of the PoseFramePayload rules (used when pydantic is not installed)."""
    problems = []
    allowed = {"mode", "detector", "detector_revision", "image", "persons_detected", "tracking_state",
               "inference_ms", "dropped_frames_since_last", "coordinate_space_2d", "coordinate_space_3d",
               "joints_2d", "joints_3d", "body_height_m", "height_estimation", "camera_origin_matrix",
               "observation_confidence", "root_camera_position_m"}
    problems += [f"unknown field {k}" for k in payload if k not in allowed]
    for key in ("mode", "detector", "image", "persons_detected", "tracking_state"):
        if key not in payload:
            problems.append(f"missing {key}")
    if payload.get("mode") not in ("2d", "3d"):
        problems.append("mode")
    if len(str(payload.get("detector", ""))) > 64:
        problems.append("detector too long")
    image = payload.get("image") or {}
    if set(image) - {"width", "height", "orientation", "mirrored", "camera_position"}:
        problems.append("image has unknown fields")
    if not (isinstance(image.get("width"), int) and image["width"] > 0 and isinstance(image.get("height"), int)
            and image["height"] > 0):
        problems.append("image width/height")
    if not (isinstance(payload.get("persons_detected"), int) and 0 <= payload["persons_detected"] <= 16):
        problems.append("persons_detected")
    if payload.get("tracking_state") not in ("tracking", "no_person", "interrupted"):
        problems.append("tracking_state")
    if payload.get("inference_ms") is not None and payload["inference_ms"] < 0:
        problems.append("inference_ms")
    if payload.get("dropped_frames_since_last", 0) < 0:
        problems.append("dropped_frames_since_last")
    if payload.get("coordinate_space_2d", "image_normalized_top_left") != "image_normalized_top_left":
        problems.append("coordinate_space_2d")
    joints = payload.get("joints_2d") or []
    if len(joints) > 32:
        problems.append("too many joints")
    for joint in joints:
        if set(joint) != {"name", "x", "y", "confidence"}:
            problems.append(f"joint fields {sorted(joint)}")
            continue
        if joint["name"] not in WIRE_2D_NAMES:
            problems.append(f"joint name {joint['name']}")
        if not (-0.05 <= joint["x"] <= 1.05 and -0.05 <= joint["y"] <= 1.05):
            problems.append(f"{joint['name']} outside -0.05..1.05")
        if not 0 <= joint["confidence"] <= 1:
            problems.append(f"{joint['name']} confidence")
    if payload.get("observation_confidence") is not None and not 0 <= payload["observation_confidence"] <= 1:
        problems.append("observation_confidence")
    return problems


def operator_token() -> str | None:
    """Operator token of a backend on this Mac (never printed)."""
    token = os.environ.get("COACH_API_TOKEN")
    if token:
        return token.strip()
    runtime = Path(os.environ.get("COACH_RUNTIME_DIR") or COACH_RUNTIME_DIR)
    try:
        return (runtime / "api_token").read_text(encoding="utf-8").strip() or None
    except OSError:
        return None


class CoachError(RuntimeError):
    pass


class _AuthRejected(CoachError):
    pass


class CoachLink:
    """Background sender. Thread-safe API: submit(), status_line(), stats, close()."""

    def __init__(self, base_url: str = DEFAULT_COACH_URL, *, code: str | None = None, device_id: str | None = None,
                 model_name: str = "yolo26n-pose", operator_token: str | None = None, queue_size: int = QUEUE_SIZE,
                 sequence_file: Path | None = SEQUENCE_FILE):
        self.base_url = base_url.rstrip("/")
        self.ingest_url = self.base_url.replace("https://", "wss://").replace("http://", "ws://") + "/v1/ingest"
        self.code = code
        self.device_id = device_id or device_id_for_host()
        self.model_name = model_name
        self._operator_token = operator_token   # default: COACH_API_TOKEN or services/coach/.runtime/api_token
        self._lock = threading.Lock()
        self._queue: deque = deque(maxlen=queue_size)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._token: str | None = None
        self._code_used = False
        self._sequence_file = sequence_file
        self._sequence = load_sequence(sequence_file, self.device_id)
        save_sequence(sequence_file, self.device_id, self._sequence, clean=False)
        self._next_due = 0.0
        self._last_camera_seq = 0
        self.rate_hz = DEFAULT_RATE_HZ
        self.session: dict | None = None
        self.backpressure = False
        self.state = "starting"
        self.last_error: str | None = None
        self.stats = {"submitted": 0, "rate_limited": 0, "not_running": 0, "queue_dropped": 0, "stale_dropped": 0,
                      "sent": 0, "accepted": 0, "duplicates": 0, "rejected": 0, "reconnects": 0}
        self.last_rejection: str | None = None

    # ------------------------------------------------------------------ producer side (never blocks)
    def start(self) -> "CoachLink":
        self._thread = threading.Thread(target=self._run, name="coach-link", daemon=True)
        self._thread.start()
        return self

    def close(self, timeout: float = 3.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout)
        with self._lock:
            stopped = self._thread is None or not self._thread.is_alive()
            save_sequence(self._sequence_file, self.device_id, self._sequence, clean=stopped)

    def submit(self, people: list, width: int, height: int, camera_seq: int, captured_mono: float,
               inference_ms: float | None) -> bool:
        """Offer one inferred frame. Returns True if it was queued for sending.

        captured_mono is time.perf_counter() when the Mac received the frame (Frame.received);
        it is converted to wall-clock time for `captured_at`.
        """
        captured_wall = time.time() - (time.perf_counter() - captured_mono)
        with self._lock:
            session = self.session
            if not session or session.get("state") != "running":
                self.stats["not_running"] += 1
                return False
            interval = 1.0 / max(0.5, self.rate_hz)
            if captured_mono < self._next_due:
                self.stats["rate_limited"] += 1
                return False
            # Keep the cadence (average = pose_rate_hz); restart it after a pause.
            behind = captured_mono - self._next_due
            self._next_due = (self._next_due if behind < interval else captured_mono) + interval
            # Camera frames between the previous submitted frame and this one were not sent
            # (skipped by the inference worker or by the rate limit).
            dropped = max(0, camera_seq - self._last_camera_seq - 1) if self._last_camera_seq else 0
            self._last_camera_seq = camera_seq
            payload = build_pose_payload(people, width, height, model_name=self.model_name,
                                         inference_ms=inference_ms, dropped_frames=dropped)
            if len(self._queue) == self._queue.maxlen:
                self.stats["queue_dropped"] += 1
            self._queue.append({"payload": payload, "captured_wall": captured_wall, "captured_mono": captured_mono,
                                "session_id": session["session_id"]})
            self.stats["submitted"] += 1
            return True

    def status_line(self) -> str:
        with self._lock:
            session, state, stats = self.session, self.state, dict(self.stats)
        if state != "connected":
            return f"coach: {state}"
        if not session:
            return "coach: connected, waiting for a session"
        text = f"coach: {session.get('state')} {session.get('session_id', '')[:12]}"
        if session.get("state") == "running":
            text += f"  sent {stats['sent']}  ok {stats['accepted']}"
            if stats["rejected"]:
                text += f"  rejected {stats['rejected']}"
        if self.backpressure:
            text += "  backpressure"
        return text

    # ------------------------------------------------------------------ sender thread
    def _set(self, **values) -> None:
        with self._lock:
            for key, value in values.items():
                setattr(self, key, value)

    def _run(self) -> None:
        attempt = 0
        while not self._stop.is_set():
            try:
                self._connect_and_stream()
                attempt = 0
            except _AuthRejected as exc:
                self._token = None  # pair again on the next attempt (local) or ask for a new code
                self._set(state=f"offline: {exc}", last_error=str(exc))
            except Exception as exc:  # network errors, server errors, protocol errors
                self._set(state=f"offline: {_explain(exc, self.base_url)}", last_error=str(exc))
            with self._lock:
                self.session = None
                self.backpressure = False
                self.stats["stale_dropped"] += len(self._queue)
                self._queue.clear()
            if self._stop.is_set():
                break
            with self._lock:
                self.stats["reconnects"] += 1
            delay = min(10.0, 0.5 * 2 ** attempt)
            attempt += 1
            self._set(state=f"{self.state.split(' (retry')[0]} (retry in {delay:.0f} s)")
            self._stop.wait(delay)
        self._set(state="stopped")

    def _device_token(self) -> str:
        if self._token:
            return self._token
        import httpx

        self._set(state="pairing")
        with httpx.Client(base_url=self.base_url, timeout=5.0) as http:
            code = self.code
            if code:
                self.code = None  # pairing codes are single use
                self._code_used = True
            else:
                token = self._operator_token or operator_token()
                if not token and self._code_used:
                    raise CoachError("the pairing code was used up; restart with a new --coach-code")
                if not token:
                    raise CoachError("no operator token (start the backend on this Mac, set COACH_API_TOKEN, "
                                     "or pass --coach-code)")
                response = http.post("/v1/pairing-codes", headers={"Authorization": f"Bearer {token}"})
                if response.status_code >= 400:
                    raise CoachError(f"pairing code request failed: HTTP {response.status_code} {_code(response)}")
                code = response.json()["code"]
            response = http.post("/v1/devices/pair", json={"code": code, "device_id": self.device_id, "kind": "mac",
                                                           "name": "vision (YOLO pose)"})
            if response.status_code >= 400:
                raise CoachError(f"pairing failed: HTTP {response.status_code} {_code(response)}")
            self._token = response.json()["device_token"]
        return self._token

    def _connect_and_stream(self) -> None:
        from websockets.sync.client import connect

        token = self._device_token()
        self._set(state="connecting")
        with connect(self.ingest_url, additional_headers={"Authorization": f"Bearer {token}"},
                     open_timeout=5, close_timeout=2, max_size=2**20) as ws:
            hello = json.loads(ws.recv(timeout=10))
            if hello.get("type") != "auth.ok":
                raise _AuthRejected(f"ingest auth refused ({hello.get('error', {}).get('code', hello.get('type'))})")
            self._sync_clock(ws)
            ws.send(json.dumps({"type": "join", "session_id": None}))
            last_join = time.monotonic()
            self._set(state="connected", last_error=None)
            while not self._stop.is_set():
                self._receive_pending(ws)
                with self._lock:
                    session = self.session
                if (not session or session.get("state") == "ended") and time.monotonic() - last_join >= JOIN_RETRY_S:
                    ws.send(json.dumps({"type": "join", "session_id": None}))
                    last_join = time.monotonic()
                batch = self._take_batch()
                if batch:
                    ws.send(json.dumps({"type": "events", "events": batch}))
                    with self._lock:
                        self.stats["sent"] += len(batch)
            ws.close()

    def _sync_clock(self, ws, rounds: int = 5) -> None:
        for _ in range(rounds):
            t0 = time.time() * 1000
            ws.send(json.dumps({"type": "clock.ping", "t0": t0}))
            pong = self._expect(ws, "clock.pong")
            t3 = time.time() * 1000
            ws.send(json.dumps({"type": "clock.sample", "t0": t0, "t1": pong["t1"], "t2": pong["t2"], "t3": t3}))
            self._expect(ws, "clock.estimate")

    def _expect(self, ws, kind: str, timeout: float = 5.0) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise CoachError(f"no {kind} from the backend")
            msg = json.loads(ws.recv(timeout=remaining))
            if msg.get("type") == kind:
                return msg
            self._handle(msg)

    def _receive_pending(self, ws) -> None:
        """Handle every message that is already waiting; wait at most ~20 ms."""
        timeout = 0.02
        while True:
            try:
                raw = ws.recv(timeout=timeout)
            except TimeoutError:
                return
            self._handle(json.loads(raw))
            timeout = 0

    def _handle(self, msg: dict) -> None:
        kind = msg.get("type")
        with self._lock:
            if kind == "session":
                self.session = msg.get("session") or None
                rate = (self.session or {}).get("pose_rate_hz")
                if isinstance(rate, (int, float)) and rate > 0:
                    self.rate_hz = float(rate)
                if not self.session or self.session.get("state") != "running":
                    self._queue.clear()
            elif kind == "ack":
                for result in msg.get("results") or []:
                    status = result.get("status")
                    if status == "accepted":
                        self.stats["accepted"] += 1
                    elif status == "duplicate":
                        self.stats["duplicates"] += 1
                    else:
                        self.stats["rejected"] += 1
                        self.last_rejection = f"{result.get('code')}: {result.get('message', '')}"
            elif kind == "backpressure":
                self.backpressure = msg.get("state") == "on"
            elif kind == "error":
                error = msg.get("error") or {}
                if error.get("code") == "no_active_session":
                    self.session = None
                else:
                    self.last_error = f"{error.get('code')}: {error.get('message')}"

    def _take_batch(self) -> list[dict]:
        now = time.perf_counter()
        with self._lock:
            items = list(self._queue)
            self._queue.clear()
            session = self.session
            if not items or not session or session.get("state") != "running":
                return []
            fresh = [i for i in items if now - i["captured_mono"] <= MAX_FRAME_AGE_S
                     and i["session_id"] == session["session_id"]]
            self.stats["stale_dropped"] += len(items) - len(fresh)
            if self.backpressure and len(fresh) > 1:
                self.stats["queue_dropped"] += len(fresh) - 1
                fresh = fresh[-1:]
            batch = []
            for item in fresh[-MAX_BATCH:]:
                batch.append(self._envelope(item))
            return batch

    def _envelope(self, item: dict) -> dict:
        """Same envelope as coach.client.EventFactory.event (sequence assigned at transmission)."""
        sequence = self._sequence
        self._sequence += 1
        if self._sequence % SEQUENCE_SAVE_EVERY == 0:
            save_sequence(self._sequence_file, self.device_id, self._sequence, clean=False)
        return {"schema_version": "1.0", "event_id": f"ev-{uuid.uuid4().hex[:20]}",
                "session_id": item["session_id"],
                "source": {"device_id": self.device_id, "kind": "mac", "simulated": False},
                "sequence": sequence, "event_type": "pose.frame", "captured_at": iso_utc(item["captured_wall"]),
                "source_monotonic_ms": round(item["captured_mono"] * 1000, 3), "payload": item["payload"]}


def _code(response) -> str:
    try:
        return str(response.json().get("error", {}).get("code"))
    except ValueError:
        return ""


def _explain(exc: BaseException, base_url: str) -> str:
    if type(exc).__name__ in ("ConnectError", "ConnectTimeout"):  # httpx
        return f"cannot reach {base_url}"
    if isinstance(exc, (ConnectionRefusedError, ConnectionError, OSError)) and not isinstance(exc, TimeoutError):
        return f"cannot reach {base_url} ({type(exc).__name__})"
    if isinstance(exc, TimeoutError):
        return f"{base_url} timed out"
    text = str(exc) or type(exc).__name__
    return text if len(text) <= 80 else text[:77] + "..."

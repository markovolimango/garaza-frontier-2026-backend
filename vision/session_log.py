"""Optional per-session log of inferred frames: session.json + frames.jsonl."""

from __future__ import annotations

import json
import math
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

DESCRIPTIONS = {
    "coordinates": (
        "Keypoint x/y are pixels in the original, unmirrored camera frame as returned by OpenCV "
        "(per-frame width/height are stored); origin at the top-left corner, x grows right, y grows down. "
        "--mirror only flips the on-screen view, never the logged coordinates."
    ),
    "timestamps": (
        "t = seconds since session start on the Mac's monotonic clock (time.perf_counter). It is taken in the "
        "camera thread immediately after OpenCV returned the frame, before inference. It is the time the Mac "
        "received the frame, NOT the sensor exposure time on the iPhone: capture, transfer and decoding latency "
        "come before it. started_at_utc was read at the same moment as t = 0."
    ),
    "frames": (
        "One line per inferred frame: every camera frame that went through pose estimation. The window shows "
        "only the newest result, so some logged frames may never have been displayed. Camera frames that "
        "arrived while the previous one was being inferred are skipped; gaps in camera_seq show them. "
        "This is not a video recording and not a record of every camera frame; no images are stored."
    ),
    "keypoints": (
        "Each keypoint has name, x, y, confidence and valid. valid=true only if the values are finite, "
        "confidence >= keypoint_conf_threshold and the point is inside the frame. Invalid points keep the raw "
        "model estimate (null if non-finite) and must not be treated as measured positions."
    ),
    "status": (
        "recording while running; completed, incomplete, interrupted or error at the end. worker_stopped=false means the "
        "inference thread was still running when the log was closed: frames it produced afterwards were "
        "dropped and counted in late_writes_dropped, so the end of the log may be incomplete."
    ),
    "people": (
        "detection_index is the order of detections inside one frame only. There is no tracker, so it is NOT "
        "a persistent person identity across frames. Frames without detections have people = []."
    ),
}


def _json_safe(value):
    """Replace non-finite floats with None so every line is strict JSON."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


def _dumps(value, **kwargs) -> str:
    return json.dumps(_json_safe(value), allow_nan=False, ensure_ascii=False, **kwargs)


def _write_json_atomic(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(_dumps(data, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def unique_session_dir(base: Path, label: str) -> Path:
    """Create and return a new folder; never reuses an existing one."""
    base.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime("%Y-%m-%d_%H-%M-%S")
    for attempt in range(1, 1000):
        name = f"{stamp}_{label}" if attempt == 1 else f"{stamp}_{label}_{attempt}"
        path = base / name
        try:
            path.mkdir()
            return path
        except FileExistsError:
            continue
    raise RuntimeError(f"Could not create a unique session folder in {base}")


class SessionLog:
    """Writes session.json (metadata) and frames.jsonl. Use as a context manager.

    write_frame() may be called from another thread. After close() further writes are dropped
    (counted in late_writes_dropped) instead of raising on a closed file.
    """

    def __init__(self, base_dir: Path, label: str, metadata: dict):
        self.directory = unique_session_dir(base_dir, label)
        self.meta_path = self.directory / "session.json"
        self.frames_path = self.directory / "frames.jsonl"
        self.frames_written = 0
        self.late_writes_dropped = 0
        self.worker_stopped: bool | None = None   # set by the app before closing
        self.closed = False
        self._lock = threading.Lock()
        now = datetime.now(timezone.utc)
        self.t0 = time.perf_counter()  # t = 0 for every frame timestamp
        self.metadata = {
            "schema_version": SCHEMA_VERSION,
            "status": "recording",
            "started_at_utc": now.isoformat(),
            "started_at_local": now.astimezone().isoformat(),
            "files": {"metadata": self.meta_path.name, "frames": self.frames_path.name},
            **metadata,
            "description": DESCRIPTIONS,
        }
        _write_json_atomic(self.meta_path, self.metadata)
        self._frames = self.frames_path.open("x", encoding="utf-8", buffering=1)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        if exc_type is None:
            self.close("completed")
        elif issubclass(exc_type, KeyboardInterrupt):
            self.close("interrupted", "Ctrl+C / SIGTERM")
        else:
            self.close("error", f"{exc_type.__name__}: {exc}")
        return False

    def write_frame(self, frame_index: int, received: float, camera_seq: int,
                    width: int, height: int, people: list) -> None:
        record = {
            "frame_index": frame_index,
            "t": round(received - self.t0, 6),
            "camera_seq": camera_seq,
            "width": width,
            "height": height,
            "people": people,
        }
        line = _dumps(record, separators=(",", ":")) + "\n"
        with self._lock:
            if self.closed:
                self.late_writes_dropped += 1
                self.metadata["late_writes_dropped"] = self.late_writes_dropped
                _write_json_atomic(self.meta_path, self.metadata)  # rare: a stuck worker finished late
                return
            self._frames.write(line)
            self.frames_written += 1

    def close(self, status: str = "completed", reason: str | None = None) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            try:
                self._frames.close()
            finally:
                if self.worker_stopped is False:
                    note = "inference thread did not stop in time; later frames were dropped"
                    reason = f"{reason}; {note}" if reason else note
                    if status == "completed":
                        status = "incomplete"
                self.metadata.update(
                    status=status,
                    ended_at_utc=datetime.now(timezone.utc).isoformat(),
                    duration_s=round(time.perf_counter() - self.t0, 3),
                    frames_written=self.frames_written,
                    worker_stopped=self.worker_stopped,
                    late_writes_dropped=self.late_writes_dropped,
                )
                if reason:
                    self.metadata["end_reason"] = reason
                _write_json_atomic(self.meta_path, self.metadata)

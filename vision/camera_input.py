"""Camera input through OpenCV (AVFoundation on macOS).

A background thread keeps only the newest frame (one-slot buffer), so a slow consumer
skips frames instead of building a queue and growing latency. All GUI work stays on the
main thread; this module never touches windows.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field

REQUEST_WIDTH, REQUEST_HEIGHT, REQUEST_FPS = 1280, 720, 30
FIRST_FRAME_TIMEOUT_S = 10.0


class CameraError(RuntimeError):
    """Camera cannot be opened or stopped delivering frames."""


@dataclass
class Frame:
    seq: int            # number of frames received from the camera so far (1-based)
    received: float     # time.perf_counter() right after OpenCV returned the frame
    image: object       # BGR numpy array, owned by the consumer


def backend():
    import cv2

    if sys.platform == "darwin":
        return cv2.CAP_AVFOUNDATION, "AVFoundation"
    return cv2.CAP_ANY, "OpenCV default"


@contextmanager
def capture_native_stderr():
    """Capture process-level stderr (fd 2), where OpenCV's native code prints its messages."""
    sys.stderr.flush()
    saved = os.dup(2)
    box = {"text": ""}
    with tempfile.TemporaryFile() as tmp:
        os.dup2(tmp.fileno(), 2)
        try:
            yield box
        finally:
            sys.stderr.flush()
            os.dup2(saved, 2)
            os.close(saved)
            tmp.seek(0)
            box["text"] = tmp.read().decode("utf-8", "replace")


@dataclass
class OpenDiagnosis:
    permission: str | None = None   # "denied" or "requested"
    device_count: int | None = None
    raw: str = ""


def diagnose_messages(text: str) -> OpenDiagnosis:
    """Interpret OpenCV AVFoundation messages (see cap_avfoundation_mac.mm)."""
    diag = OpenDiagnosis(raw=text)
    if "access has been denied" in text:
        diag.permission = "denied"
    elif "not authorized to capture video" in text:
        diag.permission = "requested"
    match = re.search(r"out device of bound \(0-(-?\d+)\)", text)
    if match:
        diag.device_count = int(match.group(1)) + 1
    elif "didn't find any attached Video Input Devices" in text:
        diag.device_count = 0
    return diag


def permission_hint(diag: OpenDiagnosis) -> str:
    if diag.permission == "denied":
        return ("macOS has denied camera access for the app running this command. Open System Settings > "
                "Privacy & Security > Camera, enable Terminal (or your IDE), quit and reopen that app, then retry.")
    if diag.permission == "requested":
        return ("macOS has just asked for camera permission. Click Allow in the dialog (it names Terminal or "
                "your IDE), then run the command again.")
    return ""


def open_capture(index: int):
    """Open a camera index on the main thread. Returns (capture, diagnosis)."""
    import cv2

    backend_id, _ = backend()
    with capture_native_stderr() as out:
        cap = cv2.VideoCapture(index, backend_id)
    return cap, diagnose_messages(out["text"])


def open_failure_message(index: int, diag: OpenDiagnosis | None) -> str:
    parts = [f"Cannot open camera {index}."]
    if diag is not None:
        if diag.permission:
            parts.append(permission_hint(diag))
        elif diag.device_count == 0:
            parts.append("OpenCV found no cameras at all.")
        elif diag.device_count is not None:
            parts.append(f"OpenCV sees {diag.device_count} camera(s): valid indices are 0-{diag.device_count - 1}.")
    parts.append("Run `bash vision/run.sh --list-cameras`. Close FaceTime/Zoom/Photo Booth if they use the camera.")
    return " ".join(parts)


class CameraStream:
    """Context manager: open camera, verify a first frame, then read in a background thread.

    Usage: with CameraStream(1) as cam: ...; cam.start(); frame = cam.latest_after(seq, 0.03)
    """

    def __init__(self, index: int, frame_timeout: float = 5.0,
                 first_frame_timeout: float = FIRST_FRAME_TIMEOUT_S, capture_factory=None):
        self.index = index
        self.frame_timeout = frame_timeout
        self.first_frame_timeout = first_frame_timeout
        self._capture_factory = capture_factory
        self._cap = None
        self._thread = None
        self._stop = threading.Event()
        self._cond = threading.Condition()
        self._latest: Frame | None = None
        self._seq = 0
        self._last_frame_at = 0.0
        self._receipts = deque(maxlen=60)
        self.error: BaseException | None = None
        self.info: dict = {}
        self.released = False

    # -- lifecycle -----------------------------------------------------------------
    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def open(self) -> dict:
        import cv2

        diag = None
        if self._capture_factory is not None:
            self._cap = self._capture_factory(self.index)
            backend_label = "injected"
        else:
            self._cap, diag = open_capture(self.index)
            backend_label = backend()[1]
        if not self._cap.isOpened():
            if diag is not None and diag.raw.strip():
                sys.stderr.write(diag.raw)
            self.close()
            raise CameraError(open_failure_message(self.index, diag))

        # Requests only: the device/backend may choose a different size or rate.
        accepted = {
            "width": bool(self._cap.set(cv2.CAP_PROP_FRAME_WIDTH, REQUEST_WIDTH)),
            "height": bool(self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT, REQUEST_HEIGHT)),
            "fps": bool(self._cap.set(cv2.CAP_PROP_FPS, REQUEST_FPS)),
        }
        image = None
        started = time.perf_counter()
        while time.perf_counter() - started < self.first_frame_timeout:
            ok, candidate = self._cap.read()  # OpenCV waits up to ~1 s per call
            if ok and candidate is not None:
                image = candidate
                break
            time.sleep(0.05)
        if image is None:
            self.close()
            raise CameraError(
                f"Camera {self.index} opened but delivered no frames within {self.first_frame_timeout:.0f} s. "
                "Unlock the iPhone and keep it near the Mac, check the cable/Trust prompt, close apps that use "
                "the camera, then retry (or pick another index with --list-cameras).")
        height, width = image.shape[:2]
        reported_fps = float(self._cap.get(cv2.CAP_PROP_FPS) or 0.0)
        self.info = {
            "index": self.index,
            "backend": backend_label,
            "requested": {"width": REQUEST_WIDTH, "height": REQUEST_HEIGHT, "fps": REQUEST_FPS},
            "request_accepted_by_backend": accepted,
            "actual_frame": {"width": int(width), "height": int(height)},
            "backend_reported_fps": round(reported_fps, 2) if reported_fps > 0 else None,
            "first_frame_after_s": round(time.perf_counter() - started, 3),
        }
        return self.info

    def start(self) -> None:
        if self._thread is not None:
            return
        self._last_frame_at = time.perf_counter()
        self._thread = threading.Thread(target=self._reader, name=f"camera-{self.index}", daemon=True)
        self._thread.start()

    def close(self) -> None:
        """Stop the reader, then release the device. Safe to call more than once."""
        self._stop.set()
        thread_stopped = True
        if self._thread is not None:
            self._thread.join(timeout=3.0)  # read() returns within ~1 s
            thread_stopped = not self._thread.is_alive()
        with self._cond:
            self._cond.notify_all()
        if self._cap is not None and not self.released:
            if thread_stopped:
                self._cap.release()
                self.released = True
            else:
                # Releasing while native read() still runs could crash; the OS frees it at exit.
                sys.stderr.write("Warning: camera thread did not stop in time; device is freed at exit.\n")

    # -- reader thread -------------------------------------------------------------
    def _reader(self) -> None:
        try:
            while not self._stop.is_set():
                ok, image = self._cap.read()
                received = time.perf_counter()
                if ok and image is not None:
                    with self._cond:
                        self._seq += 1
                        self._latest = Frame(self._seq, received, image)
                        self._last_frame_at = received
                        self._receipts.append(received)
                        self._cond.notify_all()
                elif self._stop.wait(0.02):
                    break
        except BaseException as exc:  # surfaced to the main thread
            self.error = exc
            with self._cond:
                self._cond.notify_all()

    # -- consumer API (main thread) ------------------------------------------------
    def latest_after(self, seq: int, timeout: float) -> Frame | None:
        """Newest frame with seq greater than `seq`, waiting at most `timeout` seconds."""
        with self._cond:
            if (self._latest is None or self._latest.seq <= seq) and self.error is None:
                self._cond.wait(timeout)
            if self._latest is not None and self._latest.seq > seq:
                return self._latest
        return None

    def check_health(self) -> float:
        """Raise CameraError when the reader failed or frames stopped; return seconds since last frame."""
        if self.error is not None:
            raise CameraError(f"Camera {self.index} reader failed: {self.error}")
        if self._thread is not None and not self._thread.is_alive() and not self._stop.is_set():
            raise CameraError(f"Camera {self.index} reader stopped unexpectedly.")
        silent = time.perf_counter() - self._last_frame_at
        if silent > self.frame_timeout:
            raise CameraError(
                f"No frames from camera {self.index} for {silent:.1f} s. The iPhone was probably disconnected, "
                "locked, moved away, or another app took the camera. Reconnect it and start again.")
        return silent

    def input_fps(self) -> float:
        """Measured rate of frames arriving from the camera (not the declared rate)."""
        with self._cond:
            times = list(self._receipts)
        if len(times) < 2 or times[-1] <= times[0]:
            return 0.0
        return (len(times) - 1) / (times[-1] - times[0])


# -- camera listing ----------------------------------------------------------------
@dataclass
class ProbeResult:
    index: int
    ok: bool
    width: int | None = None
    height: int | None = None
    seconds: float = 0.0
    note: str = ""


@dataclass
class ProbeReport:
    results: list = field(default_factory=list)
    device_count: int | None = None
    permission: str | None = None
    macos_cameras: list | None = None
    names: dict | None = None


def macos_cameras(timeout: float = 10.0) -> list | None:
    """Cameras known to macOS (system_profiler). Does not open any camera."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["system_profiler", "-json", "SPCameraDataType"], capture_output=True,
                             text=True, timeout=timeout, check=True).stdout
        items = json.loads(out).get("SPCameraDataType", [])
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    return [{"name": item.get("_name"), "unique_id": item.get("spcamera_unique-id")} for item in items]


def infer_names(device_count: int | None, cameras: list | None) -> dict | None:
    """Map OpenCV indices to macOS camera names, only when this can be done unambiguously.

    OpenCV 4.x (cap_avfoundation_mac.mm) sorts AVFoundation devices by uniqueID before
    indexing. The mapping is used only if macOS lists exactly as many cameras as OpenCV sees
    and every entry has a unique ID; otherwise None.
    """
    if not cameras or device_count is None or len(cameras) != device_count:
        return None
    if any(not cam.get("unique_id") or not cam.get("name") for cam in cameras):
        return None
    ordered = sorted(cameras, key=lambda cam: cam["unique_id"])
    return {index: cam["name"] for index, cam in enumerate(ordered)}


def probe_cameras(max_index: int = 4, per_index_timeout: float = 5.0, opener=open_capture) -> ProbeReport:
    """Open indices 0..max_index one by one, read one frame, and release each device."""
    report = ProbeReport()
    for index in range(max_index + 1):
        started = time.perf_counter()
        cap = None
        try:
            cap, diag = opener(index)
            if diag.permission:
                report.permission = diag.permission
                report.results.append(ProbeResult(index, False, note=permission_hint(diag)))
                break
            if diag.device_count is not None:
                report.device_count = diag.device_count
            if not cap.isOpened():
                if diag.device_count is not None and index >= diag.device_count:
                    break  # every higher index is out of range too
                report.results.append(ProbeResult(index, False, note="could not open"))
                continue
            image = None
            while time.perf_counter() - started < per_index_timeout:
                ok, candidate = cap.read()
                if ok and candidate is not None:
                    image = candidate
                    break
            seconds = round(time.perf_counter() - started, 2)
            if image is None:
                report.results.append(ProbeResult(index, False, seconds=seconds,
                                                  note=f"opened, but no frame within {per_index_timeout:.0f} s (iPhone still waking up? run again)"))
            else:
                height, width = image.shape[:2]
                report.results.append(ProbeResult(index, True, int(width), int(height), seconds))
        finally:
            if cap is not None:
                cap.release()
    report.macos_cameras = macos_cameras()
    report.names = infer_names(report.device_count, report.macos_cameras)
    return report

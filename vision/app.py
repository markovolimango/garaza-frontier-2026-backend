#!/usr/bin/env python3
"""Live body pose from an iPhone (Continuity Camera) or any Mac camera with YOLO26 pose models."""

from __future__ import annotations

import argparse
import platform
import signal
import sys
import threading
import time
import traceback
from collections import deque
from contextlib import nullcontext
from importlib import metadata as importlib_metadata

from camera_input import CameraError, CameraStream, probe_cameras
from coach_link import DEFAULT_COACH_URL, CoachError
from pose_engine import (
    KEYPOINT_NAMES, MODEL_FILES, SESSIONS_DIR, SKELETON,
    DeviceError, ModelError, PoseEngine,
)
from session_log import SessionLog

WINDOW = "garaza vision  |  Q / Esc: quit"
# BGR: the person's own left side, right side, and center/cross links.
LEFT, RIGHT, CENTER = (255, 170, 30), (30, 140, 255), (240, 240, 240)
WARN = (60, 200, 255)

EPILOG = """examples (from the repository root):
  bash vision/run.sh --list-cameras
  bash vision/run.sh --camera 1 --preview-only
  bash vision/run.sh --camera 1
  bash vision/run.sh --camera 1 --model s
  bash vision/run.sh --camera 1 --save-points
  bash vision/run.sh --camera 1 --coach       stream poses to services/coach on this Mac
  bash vision/run.sh --camera 1 --coach https://mac.local:8765 --coach-code 12345678
  bash vision/run.sh --doctor       environment diagnostics, no camera
  bash vision/run.sh --selftest     model and inference checks on sample images, no camera

The camera number is an example: pick yours with --list-cameras and --preview-only.
Quit with Q or Esc in the video window, by closing the window, or with Ctrl+C."""


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="bash vision/run.sh", description=__doc__, epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--camera", type=int, metavar="INDEX",
                        help="OpenCV camera index; find it with --list-cameras (required to show video)")
    parser.add_argument("--list-cameras", action="store_true",
                        help="probe indices 0..--max-index (up to ~5 s each, every device released), then exit")
    parser.add_argument("--max-index", type=int, default=4, metavar="N",
                        help="highest index probed by --list-cameras (default: 4)")
    parser.add_argument("--preview-only", action="store_true", help="show the camera without loading YOLO")
    parser.add_argument("--model", choices=sorted(MODEL_FILES), default="n",
                        help="n = yolo26n-pose (default, fastest); s = yolo26s-pose (larger, downloaded on first use)")
    parser.add_argument("--device", choices=["auto", "mps", "cpu"], default="auto",
                        help="auto = MPS if it passes a check against CPU, otherwise CPU (default: auto)")
    parser.add_argument("--imgsz", type=int, default=640, metavar="PIXELS", help="inference size, multiple of 32 (default: 640)")
    parser.add_argument("--keypoint-conf", type=float, default=0.5, metavar="CONF",
                        help="keypoints below this confidence are hidden and logged as invalid (default: 0.5)")
    parser.add_argument("--det-conf", type=float, default=0.25, metavar="CONF",
                        help="minimum person detection confidence (default: 0.25)")
    parser.add_argument("--save-points", action="store_true",
                        help="log inferred frames to a new folder in vision/sessions/")
    parser.add_argument("--coach", nargs="?", const=DEFAULT_COACH_URL, metavar="URL",
                        help=f"stream poses as pose.frame events to the coach backend (default URL {DEFAULT_COACH_URL}); "
                             "pairs automatically with a backend on this Mac")
    parser.add_argument("--coach-code", metavar="CODE",
                        help="pairing code from POST /v1/pairing-codes, for a backend on another machine")
    parser.add_argument("--mirror", action="store_true",
                        help="mirror the on-screen view; logged coordinates stay unmirrored")
    parser.add_argument("--frame-timeout", type=float, default=5.0, metavar="SECONDS",
                        help="stop with an error if the camera sends no frames this long (default: 5)")
    args = parser.parse_args(argv)

    if args.list_cameras:
        if not 0 <= args.max_index <= 15:
            parser.error("--max-index must be between 0 and 15.")
        return args
    if args.camera is None:
        parser.error("choose a camera with --camera INDEX (run --list-cameras first).")
    if args.camera < 0:
        parser.error("--camera must be 0 or greater.")
    if args.imgsz < 160 or args.imgsz > 1920 or args.imgsz % 32:
        parser.error("--imgsz must be a multiple of 32 between 160 and 1920.")
    if not 0.0 <= args.keypoint_conf <= 1.0:
        parser.error("--keypoint-conf must be between 0 and 1.")
    if not 0.0 < args.det_conf <= 1.0:
        parser.error("--det-conf must be greater than 0 and at most 1.")
    if args.frame_timeout < 1.0:
        parser.error("--frame-timeout must be at least 1 second.")
    if args.preview_only and args.save_points:
        parser.error("--save-points needs pose estimation; remove --preview-only.")
    if args.preview_only and args.coach:
        parser.error("--coach needs pose estimation; remove --preview-only.")
    if args.coach_code and not args.coach:
        parser.error("--coach-code needs --coach URL.")
    if args.coach and not args.coach.startswith(("http://", "https://")):
        parser.error("--coach URL must start with http:// or https://.")
    return args


# -- camera listing --------------------------------------------------------------------
def list_cameras(args) -> int:
    print(f"Probing OpenCV camera indices 0-{args.max_index} (AVFoundation, up to ~5 s each)...", flush=True)
    report = probe_cameras(args.max_index)
    if report.permission:
        print(f"\n{report.results[-1].note}")
        return 1
    names = report.names or {}
    for result in report.results:
        if result.ok:
            name = f"   ~ {names[result.index]}" if result.index in names else ""
            print(f"  [{result.index}] OK  {result.width}x{result.height}  first frame after {result.seconds:.1f} s{name}")
        else:
            print(f"  [{result.index}] --  {result.note}")
    if report.device_count is not None:
        print(f"OpenCV sees {report.device_count} camera device(s).")
    elif report.results and len(report.results) == args.max_index + 1:
        print(f"There may be more devices; probe further with --max-index {args.max_index + 4}.")

    cameras = report.macos_cameras
    if cameras:
        print("Cameras listed by macOS (system_profiler): " + ", ".join(str(c["name"]) for c in cameras))
    if names:
        print("Names marked ~ are inferred: OpenCV orders AVFoundation devices by unique ID and macOS lists the "
              "same number of cameras. Still confirm with --preview-only.")
    else:
        print("Indices cannot be matched to names reliably here (for example, Continuity Camera or virtual "
              "cameras missing from the macOS list).")
    print("\nIdentify the iPhone: bash vision/run.sh --camera INDEX --preview-only, then cover the iPhone's "
          "rear lens or move it; the right index shows it immediately. Indices can change after reconnecting.")
    return 0 if any(r.ok for r in report.results) else 1


# -- drawing -------------------------------------------------------------------------------
def _side_color(index: int):
    if index == 0:
        return CENTER
    return LEFT if index % 2 == 1 else RIGHT


def draw_people(cv2, image, people: list) -> None:
    """Draw valid keypoints and only the links whose both ends are valid."""
    height, width = image.shape[:2]
    thickness = max(2, round(min(width, height) / 300))
    radius = thickness + 2
    for person in people:
        points = [(int(round(k["x"])), int(round(k["y"]))) if k["valid"] else None for k in person["keypoints"]]
        for a, b in SKELETON:
            if points[a] is None or points[b] is None:
                continue
            color = _side_color(a) if _side_color(a) == _side_color(b) else CENTER
            cv2.line(image, points[a], points[b], color, thickness, cv2.LINE_AA)
        for index, point in enumerate(points):
            if point is not None:
                cv2.circle(image, point, radius, _side_color(index), -1, cv2.LINE_AA)
                cv2.circle(image, point, radius, (0, 0, 0), 1, cv2.LINE_AA)


def draw_hud(cv2, image, lines) -> None:
    """lines: list of (text, color). Drawn on a darkened band in the top-left corner."""
    height, width = image.shape[:2]
    scale = max(0.5, min(1.2, width / 1600))
    thick = max(1, round(scale * 2))
    pad, gap = int(10 * scale) + 4, int(12 * scale) + 6
    sizes = [cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)[0] for text, _ in lines]
    box_w = min(width, max(w for w, _ in sizes) + 2 * pad)
    box_h = min(height, sum(h for _, h in sizes) + gap * (len(lines) - 1) + 2 * pad)
    region = image[0:box_h, 0:box_w]
    region[:] = (region * 0.3).astype(region.dtype)
    y = pad
    for (text, color), (_, text_h) in zip(lines, sizes):
        y += text_h
        cv2.putText(image, text, (pad, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)
        y += gap


def _rate(times) -> float:
    if len(times) < 2 or times[-1] <= times[0]:
        return 0.0
    return (len(times) - 1) / (times[-1] - times[0])


# -- main loop -----------------------------------------------------------------------------
def _window_closed(cv2, title: str) -> bool:
    try:
        return cv2.getWindowProperty(title, cv2.WND_PROP_VISIBLE) < 1
    except cv2.error:
        return True  # window no longer exists


def _poll(cv2, title: str, check_window: bool) -> str | None:
    key = cv2.waitKey(1) & 0xFF
    if key in (ord("q"), ord("Q"), 27):
        return "Stopped (Q/Esc)."
    if check_window and _window_closed(cv2, title):
        return "Window closed."
    return None


class PoseWorker:
    """Runs pose estimation on the newest camera frame in a background thread.

    On macOS every cv2.waitKey() call costs >= 10 ms (Cocoa backend), so inference runs here
    while the main thread only draws, shows and polls the GUI. Input and output are one-slot
    buffers holding only the newest item: frames are skipped, never queued.
    """

    def __init__(self, cam: CameraStream, engine, session, coach=None):
        self.cam, self.engine, self.session, self.coach = cam, engine, session, coach
        self._cond = threading.Condition()
        self._stop = threading.Event()
        self._latest = None          # (result_id, Frame, people)
        self._result_id = 0
        self._thread = None
        self.error: BaseException | None = None
        self.model_ms = deque(maxlen=30)   # inference + keypoint extraction per frame
        self.last_result_at = time.perf_counter()

    def start(self) -> None:
        self.last_result_at = time.perf_counter()
        self._thread = threading.Thread(target=self._run, name="pose-worker", daemon=True)
        self._thread.start()

    def stop(self) -> bool:
        """Stop the thread; returns False if it is still running (stuck in an inference call)."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)  # at most one inference call in flight
            return not self._thread.is_alive()
        return True

    def _run(self) -> None:
        seq, frame_index = 0, 0
        try:
            while not self._stop.is_set():
                frame = self.cam.latest_after(seq, timeout=0.1)
                if frame is None:
                    continue
                seq = frame.seq
                people = []
                if self.engine is not None:
                    start = time.perf_counter()
                    people = self.engine.infer(frame.image)
                    elapsed_ms = (time.perf_counter() - start) * 1000.0
                    height, width = frame.image.shape[:2]
                    if self.session is not None:
                        self.session.write_frame(frame_index, frame.received, frame.seq, width, height, people)
                    if self.coach is not None:  # never blocks: bounded queue, network in its own thread
                        self.coach.submit(people, width, height, frame.seq, frame.received, elapsed_ms)
                    self.model_ms.append(elapsed_ms)
                frame_index += 1
                with self._cond:
                    self._result_id += 1
                    self._latest = (self._result_id, frame, people)
                    self.last_result_at = time.perf_counter()
                    self._cond.notify_all()
        except BaseException as exc:  # surfaced on the main thread
            self.error = exc
            with self._cond:
                self._cond.notify_all()

    def latest_after(self, result_id: int, timeout: float):
        with self._cond:
            if (self._latest is None or self._latest[0] <= result_id) and self.error is None:
                self._cond.wait(timeout)
            if self._latest is not None and self._latest[0] > result_id:
                return self._latest
        return None


def display_loop(cv2, args, cam: CameraStream, engine, session, coach=None) -> str:
    """Main thread: show processed frames, poll keys and window state, watch for stalls."""
    width = cam.info["actual_frame"]["width"]
    height = cam.info["actual_frame"]["height"]
    cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL | cv2.WINDOW_KEEPRATIO)
    fit = min(1.0, 1280 / width, 720 / height)
    cv2.resizeWindow(WINDOW, max(320, int(width * fit)), max(180, int(height * fit)))

    shown = deque(maxlen=30)  # times processed frames were displayed -> FPS of the whole pipeline
    device_label = engine.device.label if engine else "PREVIEW (no model)"
    model_label = MODEL_FILES[args.model][:-3] if engine else ""
    inference_timeout = max(10.0, args.frame_timeout * 2)
    worker = PoseWorker(cam, engine, session, coach)
    last_id, last_view, first_shown_at = 0, None, None
    stall_drawn_at = 0.0
    worker.start()
    try:
        while True:
            item = worker.latest_after(last_id, timeout=0.005)
            if worker.error is not None:
                raise worker.error
            check_window = first_shown_at is not None and time.perf_counter() - first_shown_at > 0.5
            if item is None:
                silent = cam.check_health()  # raises CameraError after --frame-timeout
                if silent > 1.0 and last_view is not None:
                    if time.perf_counter() - stall_drawn_at >= 0.5:  # low-rate redraw while the camera is silent
                        stalled = last_view.copy()
                        draw_hud(cv2, stalled, [(f"Waiting for camera frames... {silent:.0f} s", WARN)])
                        cv2.imshow(WINDOW, stalled)
                        stall_drawn_at = time.perf_counter()
                elif time.perf_counter() - worker.last_result_at > inference_timeout:
                    raise RuntimeError(f"No processed frames for {inference_timeout:.0f} s although the camera "
                                       "delivers frames; inference seems stuck. Retry with --device cpu.")
                outcome = _poll(cv2, WINDOW, check_window)
                if outcome:
                    return outcome
                continue

            last_id, frame, people = item
            image = frame.image
            frame_h, frame_w = image.shape[:2]
            if engine is not None:
                draw_people(cv2, image, people)
            view = cv2.flip(image, 1) if args.mirror else image  # overlay is flipped together with the image
            shown.append(time.perf_counter())
            first_line = f"{_rate(shown):4.1f} FPS  |  {device_label}"
            if model_label:
                first_line += f"  |  {model_label}"
            first_line += f"  |  cam {args.camera} {frame_w}x{frame_h}" + ("  |  mirrored" if args.mirror else "")
            lines = [(first_line, (255, 255, 255))]
            second = f"camera in {cam.input_fps():.0f} fps"
            if engine is not None:
                times = list(worker.model_ms)
                avg_ms = sum(times) / len(times) if times else 0.0
                second = f"people {len(people)}  |  model {avg_ms:.0f} ms/frame  |  " + second
            if session is not None:
                second += "  |  REC points"
            lines.append((second, (210, 210, 210)))
            if coach is not None:
                status = coach.status_line()
                lines.append((status, (210, 210, 210) if " running " in f"{status} " else WARN))
            if engine is not None and not people:
                lines.append(("No person detected", WARN))
            draw_hud(cv2, view, lines)
            cv2.imshow(WINDOW, view)
            last_view = view
            if first_shown_at is None:
                first_shown_at = time.perf_counter()

            outcome = _poll(cv2, WINDOW, check_window)
            if outcome:
                return outcome
    finally:
        stopped = worker.stop()  # before the session log is closed by the caller
        if session is not None:
            session.worker_stopped = stopped  # an unstopped worker makes the log "incomplete"
        if not stopped:
            print("Warning: the inference thread did not stop within 5 s.", file=sys.stderr)
        cv2.destroyAllWindows()
        for _ in range(5):  # let Cocoa process the close events
            cv2.waitKey(1)


def library_versions() -> dict:
    versions = {
        "python": platform.python_version(),
        "macos": platform.mac_ver()[0] or None,
        "machine": platform.machine(),
    }
    for package in ("torch", "torchvision", "ultralytics", "opencv-python", "numpy"):
        try:
            versions[package] = importlib_metadata.version(package)
        except importlib_metadata.PackageNotFoundError:
            versions[package] = None
    return versions


def run(args) -> int:
    import cv2

    engine = None
    if not args.preview_only:
        engine = PoseEngine(args.model, args.device, args.imgsz, args.det_conf, args.keypoint_conf)
        status = engine.load()
        print(f"Device: {status.label} (requested: {args.device}) - {status.note}", flush=True)

    coach = None
    if args.coach:
        from coach_link import CoachLink

        try:
            import httpx  # noqa: F401
            import websockets.sync.client  # noqa: F401
        except ImportError as exc:
            raise CoachError(f"--coach needs httpx and websockets ({exc}). Run: bash vision/setup.sh") from exc
        coach = CoachLink(args.coach, code=args.coach_code, model_name=MODEL_FILES[args.model][:-3]).start()
        print(f"Coach backend: {args.coach} as device {coach.device_id}; poses are sent while a session runs "
              "(the app keeps working if the backend is unreachable).", flush=True)

    print(f"Opening camera {args.camera}...", flush=True)
    session = None
    with CameraStream(args.camera, frame_timeout=args.frame_timeout) as cam:
        info = cam.info
        reported = info["backend_reported_fps"]
        print(f"Camera {args.camera} via {info['backend']}: requested 1280x720 @ 30 fps, receiving "
              f"{info['actual_frame']['width']}x{info['actual_frame']['height']}"
              f" (backend reports {reported if reported else 'unknown'} fps; on-screen FPS is measured).", flush=True)

        session_context = nullcontext()
        if args.save_points:
            session_context = SessionLog(SESSIONS_DIR, f"cam{args.camera}_{MODEL_FILES[args.model][:-3]}", {
                "model": engine.describe_model(),
                "device": {"requested": args.device, "active": engine.device.active, "label": engine.device.label,
                           "note": engine.device.note, "check": engine.device.check},
                "camera": info,
                "keypoint_conf_threshold": args.keypoint_conf,
                "display_mirrored": args.mirror,
                "keypoint_names": list(KEYPOINT_NAMES),
                "skeleton": [list(edge) for edge in SKELETON],
                "versions": library_versions(),
            })
        with session_context as session:
            if session is not None:
                print(f"Saving points to {session.directory}", flush=True)
            print("Click the video window, then Q or Esc to quit (Ctrl+C here also works).", flush=True)
            cam.start()
            try:
                outcome = display_loop(cv2, args, cam, engine, session, coach)
            finally:
                if coach is not None:
                    coach.close()
                    print(f"{coach.status_line()}; totals: {coach.stats}", flush=True)
    if session is not None:
        print(f"Saved {session.frames_written} inferred frames to {session.directory}")
    print(outcome)
    return 0


def _interrupt(signum, frame):
    raise KeyboardInterrupt


def main(argv=None) -> int:
    args = parse_args(argv)
    signal.signal(signal.SIGTERM, _interrupt)
    try:
        if args.list_cameras:
            return list_cameras(args)
        return run(args)
    except KeyboardInterrupt:
        print("\nStopped (Ctrl+C).")
        return 130
    except (CameraError, ModelError, DeviceError, CoachError) as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 2
    except Exception:
        traceback.print_exc()
        print("\nUnexpected error. Run `bash vision/run.sh --doctor`; for MPS problems retry with --device cpu.",
              file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

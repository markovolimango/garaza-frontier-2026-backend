#!/usr/bin/env python3
"""Checks that need no camera.

- download/load the real pose weights in vision/models/
- inference on the official Ultralytics sample images with people (bus.jpg, zidane.jpg)
- 17-keypoint structure, finite values, invalid-point marking, frames without detections
- device selection: CPU, and MPS (real inference compared with CPU) when available
- JSONL session log validity and file closing on errors; writes after close are dropped safely
- weights SHA-256 pinning and the .bad/re-download rules (temporary copies, download stubbed)
- coach link: COCO -> PoseFramePayload mapping, and an end-to-end run against a real
  services/coach backend on a temporary port with synthetic keypoints (no camera)
- camera reader release/timeouts and camera listing logic with a SIMULATED camera
  (these do not test a real camera; the iPhone test is manual)

Run: bash vision/run.sh --selftest [--model s]
"""

from __future__ import annotations

import argparse
import json
import math
import os
import secrets
import shutil
import subprocess
import sys
import threading
import tempfile
import time
import traceback
from pathlib import Path

import numpy as np

import pose_engine
from camera_input import CameraError, CameraStream, OpenDiagnosis, infer_names, probe_cameras
from coach_link import REPO_DIR, CoachLink, build_pose_payload, pose_payload_problems
from pose_engine import (
    DEFAULT_MODEL, KEYPOINT_NAMES, MODEL_FILES, DeviceError, ModelError, PoseEngine, check_weights,
    configure_ultralytics, extract_people, file_sha256, load_model, model_path, mps_support, parameter_device,
)
from session_log import SessionLog

COACH_DIR = REPO_DIR / "services" / "coach"
COACH_TEST_PORT = 8797


class Skip(str):
    """Returned by a check that could not run here; the text says why."""


class Warn(str):
    """Returned by a check that found a non-fatal problem (e.g. MPS unusable, CPU fallback works)."""


def require(condition, message: str) -> None:
    if not condition:
        raise AssertionError(message)


class Checks:
    def __init__(self):
        self.rows = []

    def run(self, name: str, fn) -> None:
        start = time.perf_counter()
        try:
            detail = fn()
            status = "SKIP" if isinstance(detail, Skip) else "WARN" if isinstance(detail, Warn) else "PASS"
        except Exception as exc:
            status, detail = "FAIL", f"{type(exc).__name__}: {exc}"
            traceback.print_exc()
        seconds = time.perf_counter() - start
        print(f"[{status}] {name} ({seconds:.1f} s)\n       {detail}", flush=True)
        self.rows.append((status, name))


def sample_images() -> dict:
    import cv2

    configure_ultralytics()
    from ultralytics.utils import ASSETS

    images = {}
    for name in ("bus.jpg", "zidane.jpg"):
        image = cv2.imread(str(Path(ASSETS) / name))
        require(image is not None, f"Ultralytics sample {name} is missing")
        images[name] = image
    return images


def validate_people(people, width: int, height: int, threshold: float) -> tuple[int, int]:
    """Structure + numeric checks. Returns (valid, invalid) keypoint counts."""
    require(isinstance(people, list), "people must be a list")
    valid = invalid = 0
    for index, person in enumerate(people):
        require(person["detection_index"] == index, "detection_index must follow detection order")
        points = person["keypoints"]
        require([p["name"] for p in points] == list(KEYPOINT_NAMES), "expected the 17 COCO keypoints in order")
        for point in points:
            for key in ("x", "y", "confidence"):
                value = point[key]
                require(value is None or (isinstance(value, float) and math.isfinite(value)),
                        f"{point['name']}.{key} must be a finite float or null, got {value!r}")
            expected = (point["x"] is not None and point["y"] is not None and point["confidence"] is not None
                        and point["confidence"] >= threshold
                        and 0 <= point["x"] <= width and 0 <= point["y"] <= height)
            near_threshold = point["confidence"] is not None and abs(point["confidence"] - threshold) < 1e-3
            require(point["valid"] == expected or near_threshold, f"wrong valid flag for {point}")
            if point["valid"]:
                valid += 1
            else:
                invalid += 1
    json.dumps(people, allow_nan=False)
    return valid, invalid


def check_model(size: str):
    def run():
        model = load_model(size)
        path = model_path(size)
        require(path.is_file(), f"{path} missing")
        return (f"{path} ({path.stat().st_size / 1e6:.1f} MB, sha256 {file_sha256(path)[:16]}...), "
                f"task={model.task}, kpt_shape={list(model.model.kpt_shape)}")
    return run


def check_cpu_inference(size: str):
    def run():
        model = load_model(size)
        parts = []
        for name, image in sample_images().items():
            result = model.predict(image, device="cpu", imgsz=640, conf=0.25, verbose=False)[0]
            height, width = image.shape[:2]
            people = extract_people(result, width, height, 0.5)
            require(len(people) >= 1, f"no person detected in {name}")
            valid, invalid = validate_people(people, width, height, 0.5)
            require(max(sum(p["valid"] for p in person["keypoints"]) for person in people) >= 5,
                    f"no person in {name} has 5+ confident keypoints")
            parts.append(f"{name}: {len(people)} people, {valid} valid / {invalid} invalid keypoints")
        require(any("/ 0 invalid" not in part for part in parts), "expected some low-confidence points")
        return "; ".join(parts) + "; all values finite, invalid points flagged, JSON strict"
    return run


def check_no_detections():
    model = load_model(DEFAULT_MODEL)
    parts = []
    for label, image in (("black 1280x720", np.zeros((720, 1280, 3), np.uint8)),
                         ("gray 1280x720", np.full((720, 1280, 3), 127, np.uint8))):
        result = model.predict(image, device="cpu", imgsz=640, conf=0.25, verbose=False)[0]
        people = extract_people(result, 1280, 720, 0.5)
        require(people == [], f"expected no people on {label}, got {len(people)}")
        parts.append(f"{label}: keypoints {tuple(result.keypoints.data.shape)} -> people=[]")

    class NoKeypoints:  # results without a keypoints tensor must not crash either
        keypoints = None
        boxes = None
    require(extract_people(NoKeypoints(), 10, 10, 0.5) == [], "keypoints=None must give []")
    return "; ".join(parts) + "; keypoints=None -> []"


def check_device(size: str, requested: str):
    def run():
        if requested == "mps":
            available, why = mps_support()
            if not available:
                return Skip(f"MPS not available: {why}")
        engine = PoseEngine(size, requested, log=lambda message: None)
        try:
            status = engine.load()
        except DeviceError as exc:
            return Warn(f"MPS not usable: {exc} (--device auto falls back to CPU)")
        warning = None
        if requested == "auto" and mps_support()[0] and status.active != "mps":
            warning = f"auto fell back to {status.label}: {status.note}"
        require(parameter_device(engine.model).startswith(status.active),
                f"weights on {parameter_device(engine.model)}, expected {status.active}")
        counts = []
        for name, image in sample_images().items():
            people = engine.infer(image)
            height, width = image.shape[:2]
            validate_people(people, width, height, 0.5)
            require(people, f"no person on {name} with device {status.active}")
            counts.append(f"{name} {len(people)} people")
        check = status.check
        detail = f"active={status.label}; {', '.join(counts)}"
        if status.active == "mps":
            detail += (f"; output on {check['output_device']}, max diff vs CPU {check['max_keypoint_diff_px']} px / "
                       f"conf {check['max_confidence_diff']}; {check['mps_ms']} ms MPS vs {check['cpu_ms']} ms CPU")
        else:
            detail += f"; {check.get('cpu_ms')} ms CPU; {status.note}"
        return Warn(f"{warning}; {detail}") if warning else detail
    return run


def check_session_log():
    model = load_model(DEFAULT_MODEL)
    image = sample_images()["bus.jpg"]
    result = model.predict(image, device="cpu", imgsz=640, verbose=False)[0]
    people = extract_people(result, image.shape[1], image.shape[0], 0.5)
    nan_person = [{"detection_index": 0, "score": float("nan"), "box_xyxy": None,
                   "keypoints": [{"name": n, "x": float("nan"), "y": float("inf"), "confidence": None,
                                  "valid": False} for n in KEYPOINT_NAMES]}]

    def strict_lines(path: Path) -> list:
        def reject(constant):
            raise ValueError(f"non-standard JSON constant {constant}")
        return [json.loads(line, parse_constant=reject) for line in path.read_text(encoding="utf-8").splitlines()]

    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        with SessionLog(base, "selftest", {"model": {"name": "test"}}) as log:
            start = time.perf_counter()
            log.write_frame(0, start, 1, image.shape[1], image.shape[0], people)
            log.write_frame(1, start + 0.033, 3, 1280, 720, [])
            log.write_frame(2, start + 0.066, 4, 1280, 720, nan_person)
        lines = strict_lines(log.frames_path)
        meta = json.loads(log.meta_path.read_text(encoding="utf-8"))
        require(len(lines) == 3 == meta["frames_written"], "frame count mismatch")
        require(meta["status"] == "completed" and log._frames.closed, "log not closed as completed")
        require(lines[1]["people"] == [], "frame without detections must be logged with people=[]")
        require(lines[2]["people"][0]["keypoints"][0]["x"] is None, "NaN must become null")
        require(all(set(l) == {"frame_index", "t", "camera_seq", "width", "height", "people"} for l in lines),
                "unexpected frame keys")

        second = SessionLog(base, "selftest", {})
        second.close()
        require(second.directory != log.directory, "session folders must be unique")

        try:
            with SessionLog(base, "selftest", {}) as failing:
                failing.write_frame(0, time.perf_counter(), 1, 640, 480, [])
                raise RuntimeError("simulated failure")
        except RuntimeError:
            pass
        meta = json.loads(failing.meta_path.read_text(encoding="utf-8"))
        require(failing._frames.closed and meta["status"] == "error" and "simulated failure" in meta["end_reason"],
                "file must be closed and session marked as error")
        require(len(strict_lines(failing.frames_path)) == 1, "lines before the error must stay valid")
    return ("3 frames incl. empty and NaN->null, strict JSON; unique folders; "
            "on exception: file closed, status=error, earlier lines intact")


def check_weights_logic():
    """Pinned hash, size and container checks; .bad + re-download only for files that fail them."""
    real = model_path(DEFAULT_MODEL)
    name = real.name
    saved = (pose_engine.MODELS_DIR, pose_engine.download_weights, pose_engine._load_validated)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        good = tmp / "good.pt"
        shutil.copyfile(real, good)
        pin = pose_engine.MODEL_PINS[name]
        require(check_weights(real).status == "verified", "installed weights must match the pin")
        cases = {}
        truncated = tmp / "truncated" / name
        truncated.parent.mkdir()
        truncated.write_bytes(good.read_bytes()[:-1000])
        cases["truncated"] = check_weights(truncated).status
        flipped = tmp / "flipped" / name
        flipped.parent.mkdir()
        data = bytearray(good.read_bytes())
        data[len(data) // 2] ^= 0xFF
        flipped.write_bytes(bytes(data))
        cases["same size, one byte changed"] = check_weights(flipped).status
        junk = tmp / "junk.pt"
        junk.write_bytes(b"not a zip" * 1000)
        cases["unpinned non-zip"] = check_weights(junk, {}).status
        cases["unpinned valid zip"] = check_weights(good, {}).status
        require(cases == {"truncated": "size_mismatch", "same size, one byte changed": "hash_mismatch",
                          "unpinned non-zip": "bad_container", "unpinned valid zip": "unpinned"}, str(cases))

        downloads = []

        def fake_download(size, log=print):  # stands in for the network download
            downloads.append(size)
            shutil.copyfile(good, pose_engine.model_path(size))
            return pose_engine.model_path(size)

        try:
            pose_engine.MODELS_DIR = tmp / "models"
            pose_engine.MODELS_DIR.mkdir()
            pose_engine.download_weights = fake_download
            target = pose_engine.model_path(DEFAULT_MODEL)
            # 1) tampered file -> moved to .bad, downloaded again, verified
            target.write_bytes(bytes(data))
            pose_engine.ensure_model_file(DEFAULT_MODEL, log=lambda m: None)
            bad = target.with_name(name + ".bad")
            require(downloads == [DEFAULT_MODEL] and bad.is_file() and file_sha256(target) == pin["sha256"],
                    "tampered file must be quarantined and replaced")
            bad.unlink()
            # 2) verified file that fails to load (e.g. torch incompatibility) -> clear error, file untouched
            pose_engine._load_validated = lambda path: (_ for _ in ()).throw(RuntimeError("simulated torch error"))
            try:
                pose_engine.load_model(DEFAULT_MODEL, log=lambda m: None)
                raise AssertionError("expected ModelError")
            except ModelError as exc:
                require("left in place" in str(exc), str(exc))
            require(target.is_file() and not bad.exists() and downloads == [DEFAULT_MODEL],
                    "a verified file must not be moved or re-downloaded on load errors")
        finally:
            pose_engine.MODELS_DIR, pose_engine.download_weights, pose_engine._load_validated = saved

        # 3) the download itself is verified before it is moved into place (network stubbed)
        configure_ultralytics()
        import ultralytics.utils.downloads as downloads_module
        original = downloads_module.safe_download
        try:
            pose_engine.MODELS_DIR = tmp / "models2"
            downloads_module.safe_download = lambda url, file, **kw: Path(file).write_bytes(bytes(data))
            try:
                pose_engine.download_weights(DEFAULT_MODEL, log=lambda m: None)
                raise AssertionError("tampered download was accepted")
            except ModelError as exc:
                require("failed verification" in str(exc), str(exc))
            target = pose_engine.model_path(DEFAULT_MODEL)
            require(not target.exists() and target.with_name(name + ".bad").is_file(),
                    "a tampered download must never reach the model path")
        finally:
            downloads_module.safe_download = original
            pose_engine.MODELS_DIR = saved[0]
    return ("pinned sha256 verified; truncated/modified/non-zip detected; tampered file -> .bad + re-download; "
            "load error on a verified file -> clear error, file kept; tampered download rejected")


def check_log_after_close():
    with tempfile.TemporaryDirectory() as tmp:
        log = SessionLog(Path(tmp), "selftest", {})
        errors = []
        stop = threading.Event()

        def writer():  # a worker that keeps writing while the log is closed
            index = 0
            try:
                while not stop.is_set():
                    log.write_frame(index, time.perf_counter(), index + 1, 640, 480, [])
                    index += 1
                    time.sleep(0.001)
            except Exception as exc:  # must never happen
                errors.append(exc)

        thread = threading.Thread(target=writer)
        thread.start()
        time.sleep(0.05)
        log.worker_stopped = False  # what the app records when the worker did not stop in time
        log.close("completed")
        time.sleep(0.05)
        stop.set()
        thread.join()
        meta = json.loads(log.meta_path.read_text(encoding="utf-8"))
        lines = log.frames_path.read_text(encoding="utf-8").splitlines()
        require(not errors, f"write after close raised: {errors[:1]}")
        require(log.late_writes_dropped > 0 and meta["late_writes_dropped"] == log.late_writes_dropped,
                "late writes must be counted in session.json")
        require(len(lines) == meta["frames_written"] == log.frames_written, "frames_written mismatch")
        require(meta["status"] == "incomplete" and meta["worker_stopped"] is False and "did not stop" in meta["end_reason"],
                f"status must be honest, got {meta['status']}")
    return (f"{log.frames_written} lines written, {log.late_writes_dropped} late writes dropped without error; "
            "status=incomplete, worker_stopped=false")


def _coach_pydantic_model():
    """services/coach's PoseFramePayload, only if pydantic is importable in this environment."""
    try:
        import pydantic  # noqa: F401
    except ImportError:
        return None
    sys.path.insert(0, str(COACH_DIR))
    try:
        from coach.wire import PoseFramePayload
        return PoseFramePayload
    except ImportError:
        return None
    finally:
        sys.path.remove(str(COACH_DIR))


def check_coach_payload():
    model = load_model(DEFAULT_MODEL)
    image = sample_images()["zidane.jpg"]
    height, width = image.shape[:2]
    people = extract_people(model.predict(image, device="cpu", imgsz=640, verbose=False)[0], width, height, 0.5)
    payload = build_pose_payload(people, width, height, inference_ms=12.3, dropped_frames=2)
    empty = build_pose_payload([], 1280, 720)
    for item in (payload, empty):
        problems = pose_payload_problems(item)
        require(not problems, f"payload problems: {problems}")
    best = max(people, key=lambda p: sum(k["confidence"] for k in p["keypoints"] if k["valid"]))
    valid = {k["name"]: k for k in best["keypoints"] if k["valid"]}
    joints = {j["name"]: j for j in payload["joints_2d"]}
    require(set(joints) == set(valid) and joints, "exactly the valid keypoints of one person must be sent")
    for name, joint in joints.items():
        require(abs(joint["x"] - valid[name]["x"] / width) < 1e-4 and abs(joint["y"] - valid[name]["y"] / height) < 1e-4,
                f"{name}: wrong normalization")
    require(payload["persons_detected"] == len(people) and payload["tracking_state"] == "tracking", "counts")
    require(empty["tracking_state"] == "no_person" and "joints_2d" not in empty, "empty frame")
    contract = _coach_pydantic_model()
    if contract is not None:
        contract.model_validate(payload)
        contract.model_validate(empty)
        how = "validated with services/coach PoseFramePayload (pydantic)"
    else:
        how = "validated by field/range rules (pydantic is not installed in vision/.venv)"
    return (f"zidane.jpg: {len(people)} people -> 1 reported, {len(joints)} valid joints, normalized top-left; "
            f"empty frame -> no_person; {how}")


def _synthetic_person(t: float, width: int = 1280, height: int = 720) -> dict:
    """A standing person with a slowly waving right arm (pixel coordinates, all keypoints valid)."""
    base = {"nose": (640, 150), "left_eye": (655, 140), "right_eye": (625, 140), "left_ear": (670, 148),
            "right_ear": (610, 148), "left_shoulder": (720, 240), "right_shoulder": (560, 240),
            "left_elbow": (760, 340), "right_elbow": (520, 340), "left_wrist": (770, 430),
            "right_wrist": (500, 430), "left_hip": (690, 450), "right_hip": (590, 450),
            "left_knee": (695, 570), "right_knee": (585, 570), "left_ankle": (700, 690), "right_ankle": (580, 690)}
    wave = 40 * math.sin(2 * math.pi * 0.5 * t)
    points = []
    for name in KEYPOINT_NAMES:
        x, y = base[name]
        if name == "right_wrist":
            x, y = x - wave, y - abs(wave)
        points.append({"name": name, "x": float(x), "y": float(y), "confidence": 0.9, "valid": True})
    return {"detection_index": 0, "score": 0.92, "box_xyxy": [480.0, 100.0, 800.0, 700.0], "keypoints": points}


def check_coach_end_to_end():
    python = COACH_DIR / ".venv" / "bin" / "python"
    if not python.is_file():
        return Skip(f"{python} not found (set up services/coach first)")
    import httpx

    base = f"http://127.0.0.1:{COACH_TEST_PORT}"
    try:
        httpx.get(f"{base}/health", timeout=0.5)
        raise AssertionError(f"port {COACH_TEST_PORT} is already in use; stop that process and retry")
    except httpx.TransportError:
        pass
    token = secrets.token_urlsafe(24)
    with tempfile.TemporaryDirectory() as runtime:
        env = {**os.environ, "COACH_RUNTIME_DIR": runtime, "COACH_API_TOKEN": token,
               "COACH_ASSISTANT_ENABLED": "0", "COACH_HOST": "127.0.0.1"}
        log_path = Path(runtime) / "server.log"
        with log_path.open("w") as server_log:
            server = subprocess.Popen([str(python), "-m", "coach", "serve", "--port", str(COACH_TEST_PORT),
                                       "--log-level", "warning"], cwd=COACH_DIR, env=env,
                                      stdout=server_log, stderr=subprocess.STDOUT)
        link = None
        try:
            deadline = time.monotonic() + 20
            while True:
                try:
                    if httpx.get(f"{base}/health", timeout=0.5).status_code == 200:
                        break
                except httpx.TransportError:
                    pass
                require(server.poll() is None, f"backend exited: {log_path.read_text()[-500:]}")
                require(time.monotonic() < deadline, "backend did not start within 20 s")
                time.sleep(0.2)
            http = httpx.Client(base_url=base, headers={"Authorization": f"Bearer {token}"}, timeout=5)
            created = http.post("/v1/sessions", json={"label": "vision selftest", "mic_source": "none"})
            require(created.status_code == 201, f"create session: {created.status_code} {created.text[:200]}")
            session_id = created.json()["session_id"]

            link = CoachLink(base, operator_token=token, device_id="mac-vision-selftest").start()
            deadline = time.monotonic() + 10
            while (link.session or {}).get("session_id") != session_id:
                require(time.monotonic() < deadline, f"link did not join: {link.status_line()} {link.last_error}")
                time.sleep(0.05)
            started = http.post(f"/v1/sessions/{session_id}/start")
            require(started.status_code == 200, f"start session: {started.status_code} {started.text[:200]}")
            deadline = time.monotonic() + 5
            while (link.session or {}).get("state") != "running":
                require(time.monotonic() < deadline, "no running control message")
                time.sleep(0.02)

            # ~3 s of synthetic 30 fps "camera" frames; the link sends at the session's pose_rate_hz.
            submit_times, seq, t0 = [], 0, time.perf_counter()
            while time.perf_counter() - t0 < 3.0:
                seq += 1
                start = time.perf_counter()
                link.submit([_synthetic_person(start - t0)], 1280, 720, seq, start, 8.0)
                submit_times.append((time.perf_counter() - start) * 1000)
                time.sleep(1 / 30)
            deadline = time.monotonic() + 5
            while link.stats["accepted"] + link.stats["rejected"] < link.stats["sent"] and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(0.6)  # let the backend process the queue and emit body.metrics
            stats = dict(link.stats)
            require(stats["rejected"] == 0, f"rejected events: {link.last_rejection}")
            require(stats["accepted"] >= 20, f"too few accepted pose frames: {stats}")

            events = http.get(f"/v1/sessions/{session_id}/events", params={"types": "pose.frame,body.metrics",
                                                                           "limit": 5000}).json()["events"]
            poses = [e for e in events if e["event_type"] == "pose.frame"]
            metrics = [e for e in events if e["event_type"] == "body.metrics"]
            require(len(poses) == stats["accepted"], f"{len(poses)} pose.frame events vs {stats['accepted']} accepted")
            require(all(e["source"] == {"device_id": "mac-vision-selftest", "kind": "mac", "simulated": False,
                                        "relay_device_id": None} for e in poses), "source fields")
            sequences = [e["sequence"] for e in poses]
            require(sequences == list(range(sequences[0], sequences[0] + len(sequences))), "sequence gaps/reordering")
            require(all(not e["timing"]["late"] for e in poses), "frames arrived late")
            tracking = [m for m in metrics if m["payload"]["tracking_state"] == "tracking"]
            require(tracking, f"no body.metrics with tracking_state=tracking: "
                              f"{[m['payload']['tracking_state'] for m in metrics]}")
            rate = len(poses) / 3.0
            require(8 <= rate <= 13.5, f"send rate {rate:.1f}/s, expected about {link.rate_hz:.0f}/s")
            http.post(f"/v1/sessions/{session_id}/stop")
            http.close()
        finally:
            if link is not None:
                link.close()
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
    return (f"real backend on :{COACH_TEST_PORT} (temp runtime dir): paired as mac, joined, {len(poses)} pose.frame "
            f"accepted at {rate:.1f}/s (pose_rate_hz {link.rate_hz:g}), 0 rejected, contiguous sequences, "
            f"{len(tracking)} body.metrics tracking; submit() max {max(submit_times):.2f} ms; server stopped")


class FakeCapture:
    """Simulated OpenCV capture. NOT a real camera."""

    def __init__(self, frames=10**9, opened=True, delay=1 / 60):
        self.remaining, self.opened, self.delay = frames, opened, delay
        self.release_calls = 0

    def isOpened(self):
        return self.opened

    def set(self, prop, value):
        return True

    def get(self, prop):
        return 30.0

    def read(self):
        time.sleep(self.delay)
        if self.release_calls:
            raise RuntimeError("read() after release()")
        if self.remaining <= 0:
            return False, None
        self.remaining -= 1
        return True, np.zeros((72, 128, 3), np.uint8)

    def release(self):
        self.release_calls += 1


def check_camera_simulated():
    # 1) consumer raises -> reader stopped, device released exactly once
    fake = FakeCapture()
    try:
        with CameraStream(0, frame_timeout=1.0, capture_factory=lambda i: fake) as cam:
            cam.start()
            seq = 0
            for _ in range(3):
                frame = cam.latest_after(seq, 1.0)
                require(frame is not None and frame.seq > seq, "expected newer frames")
                seq = frame.seq
            raise RuntimeError("consumer failure")
    except RuntimeError as exc:
        require("consumer failure" in str(exc), str(exc))
    require(fake.release_calls == 1 and not cam._thread.is_alive(), "reader not stopped / device not released")

    # 2) frames stop (disconnect) -> clear CameraError within the timeout, then released
    fake = FakeCapture(frames=5)
    started = time.perf_counter()
    try:
        with CameraStream(0, frame_timeout=1.0, capture_factory=lambda i: fake) as cam:
            cam.start()
            seq = 0
            while time.perf_counter() - started < 5:
                frame = cam.latest_after(seq, 0.05)
                if frame is None:
                    cam.check_health()
                else:
                    seq = frame.seq
        raise AssertionError("stall was not detected")
    except CameraError as exc:
        require("No frames" in str(exc), str(exc))
    stall_seconds = time.perf_counter() - started
    require(stall_seconds < 3 and fake.release_calls == 1, f"stall took {stall_seconds:.1f} s or not released")

    # 3) cannot open / 4) opens but never delivers a frame -> CameraError, released
    for fake, label in ((FakeCapture(opened=False), "not opened"), (FakeCapture(frames=0), "no first frame")):
        try:
            with CameraStream(0, first_frame_timeout=1.0, capture_factory=lambda i: fake):
                pass
            raise AssertionError(f"{label}: expected CameraError")
        except CameraError:
            require(fake.release_calls == 1, f"{label}: device not released")
    return (f"SIMULATED camera: release on consumer error, disconnect detected in {stall_seconds:.1f} s "
            "(timeout 1 s), open failures release the device")


def check_listing_simulated():
    fakes = {}

    def opener(index):
        if index < 2:
            fakes[index] = FakeCapture()
            return fakes[index], OpenDiagnosis()
        fakes[index] = FakeCapture(opened=False)
        return fakes[index], OpenDiagnosis(device_count=2, raw="OpenCV: out device of bound (0-1): 2")

    report = probe_cameras(4, per_index_timeout=1.0, opener=opener)
    require([r.index for r in report.results] == [0, 1] and all(r.ok for r in report.results), "probe results")
    require(report.device_count == 2 and sorted(fakes) == [0, 1, 2], "must stop at the first out-of-range index")
    require(all(f.release_calls == 1 for f in fakes.values()), "every probed device must be released")

    denied = probe_cameras(4, opener=lambda i: (FakeCapture(opened=False), OpenDiagnosis(permission="denied")))
    require(denied.permission == "denied" and len(denied.results) == 1, "permission problem must stop probing")

    cams = [{"name": "B cam", "unique_id": "Z-2"}, {"name": "A cam", "unique_id": "A-1"}]
    require(infer_names(2, cams) == {0: "A cam", 1: "B cam"}, "names follow unique-id order")
    require(infer_names(3, cams) is None, "count mismatch must not produce names")
    return "SIMULATED: bounded probe stops at out-of-range index, releases every device; name mapping guarded"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", choices=sorted(MODEL_FILES), default=DEFAULT_MODEL,
                        help="also download and test this model (n is always tested)")
    args = parser.parse_args()

    sizes = [DEFAULT_MODEL] + ([args.model] if args.model != DEFAULT_MODEL else [])
    checks = Checks()
    for size in sizes:
        checks.run(f"model {MODEL_FILES[size]}: present in vision/models and loads as pose", check_model(size))
    if any(status == "FAIL" for status, _ in checks.rows):
        print("\nModel check failed; skipping the remaining checks.")
        return 1
    for size in sizes:
        checks.run(f"CPU inference {MODEL_FILES[size]} on Ultralytics bus.jpg + zidane.jpg", check_cpu_inference(size))
    checks.run("frames without detections", check_no_detections)
    for size in sizes:
        checks.run(f"device auto ({MODEL_FILES[size]})", check_device(size, "auto"))
        checks.run(f"device mps, explicit ({MODEL_FILES[size]})", check_device(size, "mps"))
        checks.run(f"device cpu, explicit ({MODEL_FILES[size]})", check_device(size, "cpu"))
    checks.run("session log: JSONL validity and closing on error", check_session_log)
    checks.run("session log: writes after close (stuck worker)", check_log_after_close)
    checks.run("weights: SHA-256 pin, .bad and re-download rules", check_weights_logic)
    checks.run("coach: COCO keypoints -> PoseFramePayload", check_coach_payload)
    checks.run("coach: end-to-end with a real services/coach backend (synthetic keypoints)", check_coach_end_to_end)
    checks.run("camera reader: release and timeouts (simulated camera)", check_camera_simulated)
    checks.run("camera listing logic (simulated camera)", check_listing_simulated)

    count = {s: sum(status == s for status, _ in checks.rows) for s in ("PASS", "WARN", "SKIP", "FAIL")}
    failed = count["FAIL"]
    print(f"\nSelftest: {count['PASS']} passed, {count['WARN']} warnings, {count['SKIP']} skipped, "
          f"{failed} failed. No real camera was used; test the iPhone manually.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

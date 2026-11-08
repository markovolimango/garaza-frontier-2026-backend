#!/usr/bin/env python3
"""Environment diagnostics for the vision module. Never opens a camera.

Run: bash vision/run.sh --doctor   (works even before setup, with the system python3)
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
from importlib import metadata as importlib_metadata
from pathlib import Path

from camera_input import macos_cameras
from pose_engine import DEFAULT_MODEL, MODEL_FILES, ULTRALYTICS_DIR, VISION_DIR, check_weights, model_path

PACKAGES = ("torch", "torchvision", "ultralytics", "opencv-python", "numpy")
OPTIONAL_PACKAGES = ("websockets", "httpx")  # only for --coach (streaming to services/coach)
CONFLICTING_OPENCV = ("opencv-python-headless", "opencv-contrib-python-headless", "opencv-contrib-python")
SETUP = "Run: bash vision/setup.sh"


class Report:
    marks = {"ok": "[ ok ]", "warn": "[warn]", "fail": "[FAIL]", "info": "[info]"}

    def __init__(self):
        self.failures, self.warnings = [], []

    def section(self, title: str) -> None:
        print(f"\n{title}")

    def add(self, status: str, label: str, value, advice: str | None = None) -> None:
        print(f"  {self.marks[status]} {label:<24} {value}")
        if advice and status in ("warn", "fail"):
            print(f"         -> {advice}")
        if status == "fail":
            self.failures.append(label)
        elif status == "warn":
            self.warnings.append(label)


def _sysctl(name: str) -> str | None:
    try:
        return subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=5).stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _version(package: str) -> str | None:
    try:
        return importlib_metadata.version(package)
    except importlib_metadata.PackageNotFoundError:
        return None


def _lock_pins() -> dict:
    pins = {}
    lock = VISION_DIR / "requirements.lock.txt"
    if lock.is_file():
        for line in lock.read_text(encoding="utf-8").splitlines():
            if "==" in line and not line.lstrip().startswith("#"):
                name, version = line.split("==", 1)
                pins[name.strip().lower().replace("_", "-")] = version.strip()
    return pins


def check_system(report: Report) -> None:
    report.section("System")
    mac = platform.mac_ver()[0]
    report.add("ok" if sys.platform == "darwin" else "warn", "OS", f"{platform.system()} {mac or platform.release()}",
               "This setup targets macOS on Apple Silicon.")
    chip = _sysctl("machdep.cpu.brand_string") or "unknown"
    hardware_arm = _sysctl("hw.optional.arm64") == "1"
    machine = platform.machine()
    if hardware_arm and machine != "arm64":
        report.add("fail", "Architecture", f"{machine} on {chip} (Rosetta)",
                   "Use a native arm64 Python (python.org universal2 installer, Homebrew in /opt/homebrew, or uv).")
    else:
        report.add("ok" if machine == "arm64" else "warn", "Architecture", f"{machine} ({chip})")


def check_python(report: Report) -> None:
    report.section("Python")
    report.add("info", "Executable", sys.executable)
    version = platform.python_version()
    supported = (3, 10) <= sys.version_info[:2] <= (3, 13)
    report.add("ok" if supported else "fail", "Version", version,
               "Use Python 3.10-3.13 (3.12 preferred), then rerun setup.")
    venv = (VISION_DIR / ".venv").resolve()
    in_venv = Path(sys.prefix).resolve() == venv
    if in_venv:
        report.add("ok", "Environment", f"project venv {venv}")
    elif (venv / "bin" / "python").exists():
        report.add("warn", "Environment", "not running inside vision/.venv",
                   "Use bash vision/run.sh --doctor to check the project environment.")
    else:
        report.add("fail", "Environment", "vision/.venv does not exist", SETUP)


def check_packages(report: Report) -> dict:
    report.section("Packages")
    pins = _lock_pins()
    found = {}
    for package in PACKAGES:
        version = _version(package)
        found[package] = version
        if version is None:
            report.add("fail", package, "not installed", SETUP)
            continue
        pinned = pins.get(package)
        if pinned and pinned != version:
            report.add("warn", package, f"{version} (lock file has {pinned})",
                       "bash vision/setup.sh reinstalls the verified versions.")
        else:
            report.add("ok", package, version + (" (matches lock)" if pinned else ""))
    for package in OPTIONAL_PACKAGES:
        version = _version(package)
        pinned = pins.get(package)
        if version is None:
            report.add("warn", package, "not installed (needed only for --coach)", SETUP)
        elif pinned and pinned != version:
            report.add("warn", package, f"{version} (lock file has {pinned})",
                       "bash vision/setup.sh reinstalls the verified versions.")
        else:
            report.add("ok", package, version + (" (matches lock)" if pinned else ""))
    for package in CONFLICTING_OPENCV:
        version = _version(package)
        if version:
            report.add("fail", package, f"{version} also installed",
                       f"Two OpenCV builds share 'cv2'. Run: vision/.venv/bin/python -m pip uninstall {package}")
    if not pins:
        report.add("warn", "Lock file", "vision/requirements.lock.txt missing", SETUP)
    return found


def check_torch(report: Report) -> None:
    report.section("PyTorch / MPS")
    try:
        import torch
    except Exception as exc:  # ImportError or broken install
        report.add("fail", "import torch", exc, SETUP)
        return
    built = torch.backends.mps.is_built()
    available = torch.backends.mps.is_available()
    report.add("ok" if built else "warn", "MPS built", built, "Install the default macOS arm64 torch wheel.")
    report.add("ok" if available else "warn", "MPS available", available,
               "Inference will use CPU. Check native arm64 Python and macOS 12.3+.")
    if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK"):
        report.add("warn", "MPS CPU fallback", "PYTORCH_ENABLE_MPS_FALLBACK is set",
                   "Unset it, so unsupported ops fail loudly instead of silently running on CPU.")
    report.add("info", "Note", "is_available() is not proof: --selftest and app startup run real MPS inference")


def check_opencv(report: Report) -> None:
    report.section("OpenCV")
    try:
        import cv2
    except Exception as exc:
        report.add("fail", "import cv2", exc, SETUP)
        return
    info = cv2.getBuildInformation()
    gui = next((line.split(":", 1)[1].strip() for line in info.splitlines() if line.strip().startswith("GUI:")), "?")
    report.add("ok" if gui.upper() == "COCOA" else "fail", "GUI backend", gui,
               "Install opencv-python (not -headless): bash vision/setup.sh")
    try:
        from cv2 import videoio_registry
        camera_backends = [videoio_registry.getBackendName(b) for b in videoio_registry.getCameraBackends()]
    except Exception:
        camera_backends = []
    has_avf = "AVFOUNDATION" in [name.upper() for name in camera_backends]
    report.add("ok" if has_avf else "fail", "Camera backend",
               ", ".join(camera_backends) or "none",
               "This OpenCV build has no AVFoundation camera support; reinstall opencv-python.")


def check_models(report: Report) -> None:
    report.section("Models (vision/models)")
    for size, name in MODEL_FILES.items():
        path = model_path(size)
        if path.is_file():
            check = check_weights(path)
            size_mb = f"{path.stat().st_size / 1e6:.1f} MB"
            if check.status == "verified":
                report.add("ok", name, f"{size_mb}  sha256 matches pin {check.sha256[:16]}...")
            elif check.status == "unpinned":
                report.add("warn", name, f"{size_mb}  {check.detail}", "Only use weights from the official release.")
            else:
                report.add("fail", name, check.detail,
                           f"Delete {path} and run: bash vision/setup.sh" + ("" if size == DEFAULT_MODEL else " --model s"))
        elif size == DEFAULT_MODEL:
            report.add("fail", name, f"missing ({path})", SETUP)
        else:
            report.add("info", name, "not downloaded yet; downloads on first --model s")
    settings = ULTRALYTICS_DIR / "Ultralytics" / "settings.json"
    if settings.is_file():
        try:
            sync = json.loads(settings.read_text(encoding="utf-8")).get("sync")
            report.add("info", "Ultralytics settings", f"{settings} (sync={sync})")
        except ValueError:
            report.add("warn", "Ultralytics settings", f"unreadable {settings}", "Delete it; it is recreated.")


def check_cameras(report: Report) -> None:
    report.section("Cameras known to macOS (system_profiler, no camera opened)")
    cameras = macos_cameras()
    if cameras is None:
        report.add("info", "Cameras", "not available on this system")
    elif not cameras:
        report.add("warn", "Cameras", "none listed", "Connect the iPhone and check it in FaceTime first.")
    else:
        for cam in cameras:
            report.add("info", "Camera", f"{cam['name']}  (unique id {cam['unique_id']})")
    report.add("info", "Note", "Continuity Camera may be missing here even when it works; use --list-cameras")
    report.add("info", "Permission", "macOS asks on first camera use; the app is Terminal/IDE, not Python")


def main() -> int:
    print(f"vision doctor  ({VISION_DIR})")
    report = Report()
    check_system(report)
    check_python(report)
    check_packages(report)
    check_torch(report)
    check_opencv(report)
    check_models(report)
    check_cameras(report)
    print()
    if report.failures:
        print(f"Problems: {', '.join(report.failures)}. Follow the -> advice above.")
        return 1
    if report.warnings:
        print(f"Usable, with warnings: {', '.join(report.warnings)}.")
    else:
        print("Environment OK. Next: bash vision/run.sh --list-cameras")
    return 0


if __name__ == "__main__":
    sys.exit(main())

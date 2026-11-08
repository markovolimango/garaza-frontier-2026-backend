"""YOLO26 pose model: local paths, download, device selection and keypoint extraction.

Heavy libraries (torch, ultralytics, cv2) are imported lazily so that doctor.py can
import the path constants with any Python, even before setup has run.
"""

from __future__ import annotations

import hashlib
import math
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

VISION_DIR = Path(__file__).resolve().parent
MODELS_DIR = VISION_DIR / "models"
SESSIONS_DIR = VISION_DIR / "sessions"
ULTRALYTICS_DIR = VISION_DIR / ".ultralytics"

MODEL_FILES = {"n": "yolo26n-pose.pt", "s": "yolo26s-pose.pt"}
DEFAULT_MODEL = "n"

# Official Ultralytics release assets, downloaded from this exact release tag only.
# Size and SHA-256 are the values GitHub publishes for the assets of that release
# (api.github.com/repos/ultralytics/assets/releases/tags/v8.4.0, field "digest").
MODEL_RELEASE_URL = "https://github.com/ultralytics/assets/releases/download/v8.4.0"
MODEL_PINS = {
    "yolo26n-pose.pt": {"size": 7_878_574,
                        "sha256": "eb3bb8268828aeaf515cec23a4bfafd793944a86fe9af94ba7823609c14522a9"},
    "yolo26s-pose.pt": {"size": 24_151_790,
                        "sha256": "a083adb42303728ae14c4bd6bd56d80da46f82fb2564dbd6f31dcc92ea321646"},
}

# COCO-17 keypoints in the order produced by Ultralytics pose models.
KEYPOINT_NAMES = (
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
)
SKELETON = (
    (0, 1), (0, 2), (1, 3), (2, 4),             # face
    (5, 6), (5, 11), (6, 12), (11, 12),         # torso
    (5, 7), (7, 9), (6, 8), (8, 10),            # arms
    (11, 13), (13, 15), (12, 14), (14, 16),     # legs
)

# MPS output must match the CPU reference within these limits (fp32 differences are ~1e-3 px).
MPS_MAX_KEYPOINT_DIFF_PX = 2.0
MPS_MAX_CONF_DIFF = 0.02


class ModelError(RuntimeError):
    """The pose model could not be downloaded, loaded or validated."""


class DeviceError(RuntimeError):
    """The explicitly requested inference device does not work."""


def model_path(size: str) -> Path:
    return MODELS_DIR / MODEL_FILES[size]


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configure_ultralytics() -> None:
    """Keep Ultralytics settings inside vision/, disable usage analytics and runtime pip installs.

    Must run before the first `import ultralytics` in the process.
    """
    os.environ["YOLO_CONFIG_DIR"] = str(ULTRALYTICS_DIR)
    os.environ["YOLO_AUTOINSTALL"] = "false"
    from ultralytics.utils import SETTINGS

    wanted = {
        "sync": False,
        "weights_dir": str(MODELS_DIR),
        "runs_dir": str(ULTRALYTICS_DIR / "runs"),
        "datasets_dir": str(ULTRALYTICS_DIR / "datasets"),
    }
    if any(SETTINGS.get(key) != value for key, value in wanted.items()):
        SETTINGS.update(wanted)


@dataclass
class WeightsCheck:
    ok: bool                    # file may be loaded
    status: str                 # "verified" | "unpinned" | "missing" | "size_mismatch" | "hash_mismatch" | "bad_container"
    detail: str
    sha256: str | None = None


def check_weights(path: Path, pins: dict | None = None) -> WeightsCheck:
    """Compare a weights file with its pinned size/SHA-256 and check its zip (torch) container.

    Never unpickles anything. A file without a pin is reported as "unpinned" (allowed, with a warning).
    """
    import zipfile

    pins = MODEL_PINS if pins is None else pins
    if not path.is_file():
        return WeightsCheck(False, "missing", f"{path.name} does not exist")
    pin = pins.get(path.name)
    actual_size = path.stat().st_size
    if pin and actual_size != pin["size"]:
        return WeightsCheck(False, "size_mismatch",
                            f"{path.name} has {actual_size} bytes, expected {pin['size']} (truncated or replaced)")
    digest = file_sha256(path)
    if pin and digest != pin["sha256"]:
        return WeightsCheck(False, "hash_mismatch",
                            f"{path.name} sha256 {digest[:16]}... differs from the pinned {pin['sha256'][:16]}...", digest)
    try:
        with zipfile.ZipFile(path) as archive:  # torch.save files are zip archives
            broken = archive.testzip()
        if broken is not None:
            return WeightsCheck(False, "bad_container", f"{path.name}: corrupt member {broken}", digest)
    except (zipfile.BadZipFile, OSError, EOFError) as exc:
        return WeightsCheck(False, "bad_container", f"{path.name} is not a readable torch zip file ({exc})", digest)
    if not pin:
        return WeightsCheck(True, "unpinned", f"{path.name} has no pinned SHA-256 (sha256 {digest}); "
                                              "its origin cannot be verified", digest)
    return WeightsCheck(True, "verified", f"{path.name} matches the pinned SHA-256", digest)


def _quarantine(path: Path, log) -> Path:
    bad = path.with_name(path.name + ".bad")
    path.replace(bad)
    log(f"Moved {path.name} to {bad.name}.")
    return bad


def download_weights(size: str, log=print) -> Path:
    """Download the pinned release asset to a .part file, verify it, then move it into place."""
    path = model_path(size)
    configure_ultralytics()
    from ultralytics.utils.downloads import safe_download

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + ".part")
    part.unlink(missing_ok=True)
    url = f"{MODEL_RELEASE_URL}/{path.name}"
    log(f"Downloading {url} into {MODELS_DIR}...")
    try:
        safe_download(url=url, file=part, unzip=False, min_bytes=1e5)
    except Exception as exc:  # network errors, HTTP errors, size validation
        part.unlink(missing_ok=True)
        raise ModelError(f"Download of {path.name} failed: {exc}") from exc
    check = _check_as(part, path.name)
    if not check.ok:
        bad = part.with_name(path.name + ".bad")
        part.replace(bad)
        raise ModelError(f"Downloaded {path.name} failed verification ({check.detail}); kept as {bad.name}, not loaded.")
    if check.status == "unpinned":
        log(f"WARNING: {check.detail}")
    part.replace(path)
    return path


def _check_as(path: Path, name: str) -> WeightsCheck:
    """check_weights for a file stored under a temporary name, using the pin of `name`."""
    pin = MODEL_PINS.get(name)
    return check_weights(path, {path.name: pin} if pin else {})


def ensure_model_file(size: str, log=print) -> Path:
    """Return a verified local weights path.

    A missing file is downloaded. A file that fails the size/SHA-256/container check is moved to
    `<name>.bad` and downloaded again. Every file is checked before it is returned.
    """
    path = model_path(size)
    if path.is_file():
        check = check_weights(path)
        if check.ok:
            if check.status == "unpinned":
                log(f"WARNING: {check.detail}")
            return path
        log(f"Local {path.name} failed verification: {check.detail}.")
        _quarantine(path, log)
    return download_weights(size, log)


def _load_validated(path: Path):
    configure_ultralytics()
    from ultralytics import YOLO

    model = YOLO(str(path))
    if model.task != "pose":
        raise ModelError(f"{path.name} is a '{model.task}' model, expected a pose model.")
    kpt_shape = getattr(model.model, "kpt_shape", None) or model.model.yaml.get("kpt_shape")
    if list(kpt_shape or []) != [len(KEYPOINT_NAMES), 3]:
        raise ModelError(f"{path.name} has keypoint shape {kpt_shape}, expected [17, 3].")
    return model


def load_model(size: str, log=print):
    """Load verified pose weights.

    Only a file that fails verification is replaced (in ensure_model_file). A verified file that
    still cannot be loaded points to the environment (e.g. a torch/ultralytics version change), so
    the file stays in place and a clear error is raised.
    """
    path = ensure_model_file(size, log)
    try:
        return _load_validated(path)
    except ModelError:
        raise
    except Exception as exc:
        raise ModelError(
            f"{path.name} passed the SHA-256 check but cannot be loaded by this environment "
            f"({type(exc).__name__}: {exc}). The file was left in place. Check the package versions with "
            "`bash vision/run.sh --doctor` or reinstall with `bash vision/setup.sh`.") from exc


def mps_support() -> tuple[bool, str]:
    import torch

    if not torch.backends.mps.is_built():
        return False, "this PyTorch build has no MPS support"
    if not torch.backends.mps.is_available():
        return False, "MPS is not available (needs Apple Silicon, macOS 12.3+ and a native arm64 Python)"
    return True, "available"


def _finite(value) -> float | None:
    value = float(value)
    return value if math.isfinite(value) else None


def extract_people(result, width: int, height: int, keypoint_conf: float) -> list[dict]:
    """Convert one Ultralytics pose result into JSON-safe dicts.

    Every keypoint keeps the raw model estimate. `valid` is true only when x, y and
    confidence are finite, confidence >= keypoint_conf and the point lies inside the frame.
    `detection_index` is the order inside this frame only, not a person identity.
    """
    keypoints = result.keypoints
    if keypoints is None or keypoints.data.shape[0] == 0:
        return []
    data = keypoints.data.detach().cpu().numpy()
    if data.ndim != 3 or data.shape[1:] != (len(KEYPOINT_NAMES), 3):
        raise ValueError(f"Expected keypoints shaped (N, 17, 3), got {tuple(data.shape)}.")
    boxes = result.boxes.xyxy.detach().cpu().numpy() if result.boxes is not None else None
    scores = result.boxes.conf.detach().cpu().numpy() if result.boxes is not None else None

    people = []
    for index, raw_points in enumerate(data):
        points = []
        for name, (raw_x, raw_y, raw_conf) in zip(KEYPOINT_NAMES, raw_points):
            x, y, conf = _finite(raw_x), _finite(raw_y), _finite(raw_conf)
            valid = (
                x is not None and y is not None and conf is not None
                and conf >= keypoint_conf
                and 0.0 <= x <= width and 0.0 <= y <= height
                # Older Ultralytics releases zeroed low-confidence points; never trust an exact (0, 0).
                and not (x == 0.0 and y == 0.0)
            )
            points.append({
                "name": name,
                "x": None if x is None else round(x, 2),
                "y": None if y is None else round(y, 2),
                "confidence": None if conf is None else round(conf, 4),
                "valid": bool(valid),
            })
        score = _finite(scores[index]) if scores is not None and index < len(scores) else None
        box = None
        if boxes is not None and index < len(boxes):
            coords = [_finite(v) for v in boxes[index]]
            box = None if None in coords else [round(v, 2) for v in coords]
        people.append({
            "detection_index": index,
            "score": None if score is None else round(score, 4),
            "box_xyxy": box,
            "keypoints": points,
        })
    return people


@dataclass
class DeviceStatus:
    requested: str
    active: str                 # "mps" or "cpu": where inference really runs
    label: str                  # shown on screen
    note: str = ""              # why this device was chosen / fallback reason
    check: dict = field(default_factory=dict)


def parameter_device(model) -> str:
    """Device of the weights the Ultralytics predictor actually runs (its own copy of the model)."""
    backend = getattr(getattr(model, "predictor", None), "model", None)
    for candidate in (getattr(backend, "model", None), backend):
        if candidate is not None and hasattr(candidate, "parameters"):
            try:
                return str(next(candidate.parameters()).device)
            except StopIteration:
                continue
    return "unknown"


def _match_detections(a_boxes, b_boxes):
    """Greedy IoU matching between two small sets of xyxy boxes."""
    pairs, used = [], set()
    for i, a in enumerate(a_boxes):
        best, best_iou = None, 0.0
        for j, b in enumerate(b_boxes):
            if j in used:
                continue
            ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
            iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
            inter = ix * iy
            union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
            iou = inter / union if union > 0 else 0.0
            if iou > best_iou:
                best, best_iou = j, iou
        if best is not None and best_iou >= 0.5:
            used.add(best)
            pairs.append((i, best))
    return pairs if len(pairs) == len(a_boxes) == len(b_boxes) else None


def compare_results(result, reference) -> dict:
    """Numerical comparison of two pose results of the same image (device vs CPU reference)."""
    import numpy as np

    a_k = result.keypoints.data.detach().cpu().numpy().astype(np.float64)
    b_k = reference.keypoints.data.detach().cpu().numpy().astype(np.float64)
    a_b = result.boxes.xyxy.detach().cpu().numpy()
    b_b = reference.boxes.xyxy.detach().cpu().numpy()
    summary = {"detections": int(len(a_k)), "reference_detections": int(len(b_k))}
    pairs = _match_detections(a_b, b_b)
    if pairs is None:
        summary.update(consistent=False, reason="detections differ between devices")
        return summary
    max_px, max_conf = 0.0, 0.0
    for i, j in pairs:
        both = (a_k[i, :, 2] >= 0.5) & (b_k[j, :, 2] >= 0.5)
        if both.any():
            max_px = max(max_px, float(np.abs(a_k[i, both, :2] - b_k[j, both, :2]).max()))
        max_conf = max(max_conf, float(np.abs(a_k[i, :, 2] - b_k[j, :, 2]).max()))
    finite = bool(np.isfinite(a_k).all())
    consistent = finite and max_px <= MPS_MAX_KEYPOINT_DIFF_PX and max_conf <= MPS_MAX_CONF_DIFF
    summary.update(
        consistent=consistent,
        max_keypoint_diff_px=round(max_px, 6),
        max_confidence_diff=round(max_conf, 6),
        finite=finite,
    )
    if not consistent:
        summary["reason"] = (
            "non-finite output" if not finite else
            f"keypoints differ from CPU by up to {max_px:.2f} px / confidence {max_conf:.3f}"
        )
    return summary


def _median_ms(fn, runs: int) -> float:
    times = []
    for _ in range(runs):
        start = time.perf_counter()
        fn()
        times.append((time.perf_counter() - start) * 1000.0)
    times.sort()
    return round(times[len(times) // 2], 1)


def reference_image():
    """Official Ultralytics sample with people (bus.jpg), shipped inside the ultralytics package."""
    import cv2

    configure_ultralytics()
    from ultralytics.utils import ASSETS

    path = Path(ASSETS) / "bus.jpg"
    image = cv2.imread(str(path))
    if image is None:
        raise ModelError(f"Ultralytics sample image not found: {path}")
    return path, image


class PoseEngine:
    """Loads one pose model on a verified device and runs per-frame inference."""

    def __init__(self, size: str, device: str = "auto", imgsz: int = 640,
                 det_conf: float = 0.25, keypoint_conf: float = 0.5, log=print):
        self.size = size
        self.requested_device = device
        self.imgsz = imgsz
        self.det_conf = det_conf
        self.keypoint_conf = keypoint_conf
        self.log = log
        self.model = None
        self.device: DeviceStatus | None = None
        self.path = model_path(size)

    def _predict(self, model, image, device):
        # FP32 (Ultralytics default); no temporal smoothing: every frame is an independent estimate.
        return model.predict(image, device=device, imgsz=self.imgsz, conf=self.det_conf, verbose=False)[0]

    def load(self) -> DeviceStatus:
        requested = self.requested_device
        self.log(f"Loading {self.path.name}...")
        live = load_model(self.size, self.log)
        _, image = reference_image()

        if requested == "cpu":
            result = self._predict(live, image, "cpu")
            check = {"cpu_ms": _median_ms(lambda: self._predict(live, image, "cpu"), 3),
                     "reference_people": int(len(result.boxes))}
            return self._use(live, DeviceStatus("cpu", "cpu", "CPU", "requested --device cpu", check))

        available, why = mps_support()
        if not available:
            if requested == "mps":
                raise DeviceError(f"--device mps was requested, but {why}. Use --device cpu.")
            return self._cpu_fallback(live, image, f"MPS unavailable: {why}")

        try:
            check = self._verify_mps(live, image)
        except Exception as exc:  # MPS kernel errors, unsupported ops, wrong output device
            if requested == "mps":
                raise DeviceError(f"MPS inference failed: {exc}. Use --device cpu.") from exc
            return self._cpu_fallback(load_model(self.size, self.log), image, f"MPS inference failed: {exc}")

        if not check["consistent"]:
            if requested == "mps":
                self.log(f"WARNING: MPS output differs from CPU ({check.get('reason')}). "
                         "Continuing on MPS because --device mps was requested.")
                return self._use(live, DeviceStatus("mps", "mps", "MPS (unverified)", check.get("reason", ""), check))
            return self._cpu_fallback(load_model(self.size, self.log), image,
                                      f"MPS output does not match CPU: {check.get('reason')}")

        note = (f"verified: matches CPU on bus.jpg (max diff {check['max_keypoint_diff_px']:.4f} px); "
                f"{check['mps_ms']} ms on MPS vs {check['cpu_ms']} ms on CPU")
        if os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK"):
            note += "; WARNING: PYTORCH_ENABLE_MPS_FALLBACK is set, unsupported ops may run on CPU"
        return self._use(live, DeviceStatus(requested, "mps", "MPS", note, check))

    def _verify_mps(self, live, image) -> dict:
        start = time.perf_counter()
        result = self._predict(live, image, "mps")  # first call also compiles Metal kernels
        warmup_ms = round((time.perf_counter() - start) * 1000.0, 1)
        output_device = str(result.keypoints.data.device)
        param_device = parameter_device(live)
        if not output_device.startswith("mps") or not param_device.startswith("mps"):
            raise RuntimeError(f"model ran on {param_device} with output on {output_device}, not on MPS")
        reference_model = load_model(self.size, self.log)
        reference = self._predict(reference_model, image, "cpu")
        check = compare_results(result, reference)
        check.update(
            output_device=output_device,
            parameter_device=param_device,
            warmup_ms=warmup_ms,
            mps_ms=_median_ms(lambda: self._predict(live, image, "mps").keypoints.data.cpu(), 5),
            cpu_ms=_median_ms(lambda: self._predict(reference_model, image, "cpu"), 2),
        )
        return check

    def _cpu_fallback(self, model, image, reason: str) -> DeviceStatus:
        self.log(f"{reason}. Falling back to CPU.")
        self._predict(model, image, "cpu")
        check = {"cpu_ms": _median_ms(lambda: self._predict(model, image, "cpu"), 2)}
        return self._use(model, DeviceStatus(self.requested_device, "cpu", "CPU (MPS fallback)", reason, check))

    def _use(self, model, status: DeviceStatus) -> DeviceStatus:
        self.model = model
        self.device = status
        return status

    def infer(self, frame) -> list[dict]:
        result = self._predict(self.model, frame, self.device.active)
        height, width = frame.shape[:2]
        return extract_people(result, width, height, self.keypoint_conf)

    def describe_model(self) -> dict:
        return {
            "name": self.path.name,
            "path": str(self.path.relative_to(VISION_DIR)),
            "size_bytes": self.path.stat().st_size,
            "sha256": file_sha256(self.path),
            "imgsz": self.imgsz,
            "detection_conf": self.det_conf,
        }

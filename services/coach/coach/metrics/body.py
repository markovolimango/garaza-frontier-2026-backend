"""Body movement observations from pose.frame events.

- Timestamp-aware One-Euro smoothing per joint; filters reset after gaps, tracking loss and
  2D/3D mode changes (the coordinate systems are not comparable).
- Movement is normalised by a stable body reference: the median torso length (mid-shoulder to
  mid-hip / center_shoulder to root) over the last few seconds.
- 2D: Vision's normalized coordinates are converted to pixel-proportional units with the image
  size first, so x and y distances are comparable. Angles are projected image-plane angles.
- 3D: model positions are relative to the root (hip); torso displacement needs the root's
  camera-relative position, otherwise it is reported as unavailable.
These are movement observations, not interpretations (no 'nervous gesture' labels).
"""

from __future__ import annotations

import math
from collections import deque
from statistics import median

from coach.config import PoseConfig

KEY_2D = ("left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
          "left_hip", "right_hip")
KEY_3D = KEY_2D + ("root", "center_shoulder")
ANGLES = {  # name: (a, vertex, b)
    "left_elbow": ("left_shoulder", "left_elbow", "left_wrist"),
    "right_elbow": ("right_shoulder", "right_elbow", "right_wrist"),
    "left_shoulder": ("left_hip", "left_shoulder", "left_elbow"),
    "right_shoulder": ("right_hip", "right_shoulder", "right_elbow"),
}

Vec = tuple[float, ...]


class OneEuro:
    """One-Euro filter (Casiez et al. 2012) for irregular timestamps."""

    def __init__(self, min_cutoff: float, beta: float, d_cutoff: float = 1.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.t: float | None = None
        self.x: float | None = None
        self.dx = 0.0

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, t: float, x: float) -> float:
        if self.t is None or t <= self.t:
            self.t, self.x, self.dx = t, x, 0.0
            return x
        dt = t - self.t
        dx = (x - self.x) / dt
        self.dx += self._alpha(self.d_cutoff, dt) * (dx - self.dx)
        cutoff = self.min_cutoff + self.beta * abs(self.dx)
        self.x += self._alpha(cutoff, dt) * (x - self.x)
        self.t = t
        return self.x


def _dist(a: Vec, b: Vec) -> float:
    return math.sqrt(sum((p - q) ** 2 for p, q in zip(a, b)))


def _mid(a: Vec, b: Vec) -> Vec:
    return tuple((p + q) / 2 for p, q in zip(a, b))


def _angle(a: Vec, v: Vec, b: Vec) -> float | None:
    u = [p - q for p, q in zip(a, v)]
    w = [p - q for p, q in zip(b, v)]
    nu, nw = math.sqrt(sum(c * c for c in u)), math.sqrt(sum(c * c for c in w))
    if nu < 1e-9 or nw < 1e-9:
        return None
    cos = max(-1.0, min(1.0, sum(p * q for p, q in zip(u, w)) / (nu * nw)))
    return math.degrees(math.acos(cos))


class BodyTracker:
    def __init__(self, cfg: PoseConfig):
        self.cfg = cfg
        self.mode: str | None = None
        self._filters: dict[str, list[OneEuro]] = {}
        self.history: deque[dict] = deque(maxlen=600)
        self._ref: deque[tuple[float, float]] = deque(maxlen=600)
        self.last_frame_t: float | None = None
        self.last_valid_t: float | None = None
        self.last_joint_ratio = 0.0
        self.latest_angles: dict = {}
        self.late_frames = 0
        self.frames = 0
        self.valid_frames = 0
        self.last_event_ids: deque[str] = deque(maxlen=5)

    def reset(self) -> None:
        self._filters.clear()
        self.history.clear()

    def _smooth(self, t: float, name: str, value: Vec) -> Vec:
        filters = self._filters.get(name)
        if filters is None or len(filters) != len(value):
            filters = [OneEuro(self.cfg.smoothing_min_cutoff_hz, self.cfg.smoothing_beta) for _ in value]
            self._filters[name] = filters
        return tuple(f(t, c) for f, c in zip(filters, value))

    def update(self, t: float, payload: dict, event_id: str) -> bool:
        """Apply one frame (t = corrected capture time). Returns False if too late to smooth."""
        if self.last_frame_t is not None and t < self.last_frame_t - self.cfg.reorder_tolerance_s:
            self.late_frames += 1
            return False
        mode = payload["mode"]
        if mode != self.mode:
            self.reset()
            self._ref.clear()
            self.mode = mode
        if self.last_frame_t is not None and t - self.last_frame_t > self.cfg.reset_after_gap_s:
            self.reset()
        self.last_frame_t = max(t, self.last_frame_t or t)
        self.frames += 1
        self.last_event_ids.append(event_id)

        joints = self._valid_joints(payload)
        keys = KEY_3D if mode == "3d" else KEY_2D
        self.last_joint_ratio = sum(1 for k in keys if k in joints) / len(keys)
        torso = self._torso(joints, mode)
        if payload["tracking_state"] != "tracking" or payload["persons_detected"] == 0 or torso is None:
            self.reset()  # smoothing restarts after tracking loss
            self.latest_angles = {}
            return True

        self.valid_frames += 1
        self.last_valid_t = t
        smoothed = {name: self._smooth(t, name, value) for name, value in joints.items()}
        center, length = self._torso(smoothed, mode) or torso
        self._ref.append((t, length))
        if mode == "3d":
            root_cam = payload.get("root_camera_position_m")
            center = self._smooth(t, "__root_camera", tuple(root_cam)) if root_cam else None
            rel = {side: smoothed.get(f"{side}_wrist") for side in ("left", "right")}  # already root-relative
        else:
            rel = {side: (tuple(p - c for p, c in zip(smoothed[f"{side}_wrist"], center))
                          if f"{side}_wrist" in smoothed else None) for side in ("left", "right")}
        plane = "3d" if mode == "3d" else "image_2d"
        self.latest_angles = {}
        for name, (a, v, b) in ANGLES.items():
            value = _angle(smoothed[a], smoothed[v], smoothed[b]) if all(k in smoothed for k in (a, v, b)) else None
            self.latest_angles[name] = None if value is None else {"value": round(value, 1), "plane": plane}
        self.history.append({"t": t, "wrists": rel, "center": center})
        return True

    def _valid_joints(self, payload: dict) -> dict[str, Vec]:
        joints: dict[str, Vec] = {}
        if payload["mode"] == "2d":
            width, height = payload["image"]["width"], payload["image"]["height"]
            for joint in payload.get("joints_2d") or []:
                if joint["confidence"] >= self.cfg.min_confidence_2d:
                    joints[joint["name"]] = (joint["x"] * width, joint["y"] * height)
        else:
            for joint in payload.get("joints_3d") or []:
                joints[joint["name"]] = tuple(joint["position_m"])
        return joints

    @staticmethod
    def _torso(joints: dict[str, Vec], mode: str) -> tuple[Vec, float] | None:
        if mode == "3d" and "center_shoulder" in joints and "root" in joints:
            top, bottom = joints["center_shoulder"], joints["root"]
        elif all(k in joints for k in ("left_shoulder", "right_shoulder", "left_hip", "right_hip")):
            top = _mid(joints["left_shoulder"], joints["right_shoulder"])
            bottom = _mid(joints["left_hip"], joints["right_hip"])
        else:
            return None
        length = _dist(top, bottom)
        if length < 1e-6:
            return None
        return _mid(top, bottom), length

    # ----------------------------------------------------------------------- outputs
    def tracking_state(self, now: float) -> str:
        if self.last_frame_t is None:
            return "unknown"
        if now - self.last_frame_t > self.cfg.stale_after_s:
            return "stale"
        if self.last_valid_t is None or now - self.last_valid_t > self.cfg.tracking_lost_after_s:
            return "lost"
        if self.last_valid_t < self.last_frame_t:
            return "partial" if now - self.last_valid_t <= self.cfg.tracking_lost_after_s else "lost"
        return "tracking" if self.last_joint_ratio >= 0.999 else "partial"

    def _path_speed(self, frames: list[dict], point, window: float) -> float | None:
        """Mean speed along the path (direction changes do not cancel out), in input units per second.
        Needs consecutive samples covering at least a quarter of the window."""
        distance, duration = 0.0, 0.0
        for prev, cur in zip(frames, frames[1:]):
            a, b = point(prev), point(cur)
            dt = cur["t"] - prev["t"]
            if a is None or b is None or dt <= 0 or dt > self.cfg.reset_after_gap_s:
                continue
            distance += _dist(a, b)
            duration += dt
        return distance / duration if duration >= 0.25 * window else None

    def metrics(self, now: float) -> dict:
        state = self.tracking_state(now)
        window = self.cfg.metrics_window_s
        refs = [length for t, length in self._ref if now - t <= self.cfg.reference_window_s]
        ref = median(refs) if refs else None
        unit_len = "m" if self.mode == "3d" else "image_px"
        frames = [h for h in self.history if now - h["t"] <= window]
        wrist: dict = {"unit": "torso_lengths_per_s", "left": None, "right": None}
        torso: dict = {"unit": "torso_lengths", "value": None, "meters": None}
        torso_speed: dict = {"unit": "torso_lengths_per_s", "value": None}
        present = state in ("tracking", "partial")
        if present and ref and len(frames) >= 2:
            for side in ("left", "right"):
                speed = self._path_speed(frames, lambda h, side=side: h["wrists"].get(side), window)
                wrist[side] = None if speed is None else round(speed / ref, 3)
            speed = self._path_speed(frames, lambda h: h["center"], window)
            torso_speed["value"] = None if speed is None else round(speed / ref, 3)
            centers = [h for h in frames if h["center"] is not None]
            if len(centers) >= 2 and centers[-1]["t"] - centers[0]["t"] >= 0.5 * window:
                moved = _dist(centers[0]["center"], centers[-1]["center"])
                torso["value"] = round(moved / ref, 3)
                if self.mode == "3d":
                    torso["meters"] = round(moved, 3)
        if self.mode == "3d" and not any(h["center"] is not None for h in frames):
            torso["note"] = "needs root_camera_position_m"
        quality = {"tracking": "good", "partial": "limited"}.get(state, "unavailable" if state != "stale" else "stale")
        if present and ref is None:
            quality = "insufficient_data"
        return {
            "body_present": present,
            "tracking_state": state,
            "quality": quality,
            "mode": self.mode,
            "window_s": window,
            "reference": None if ref is None else {"name": "torso_length", "value": round(ref, 4), "unit": unit_len,
                                                   "statistic": "median", "window_s": self.cfg.reference_window_s},
            "wrist_movement": wrist,
            "torso_displacement": torso,
            "torso_movement": torso_speed,
            "joint_angles_deg": self.latest_angles if present else {},
            "frames_in_window": len(frames),
            "smoothing": {"method": "one_euro", "min_cutoff_hz": self.cfg.smoothing_min_cutoff_hz,
                          "beta": self.cfg.smoothing_beta, "reset_after_gap_s": self.cfg.reset_after_gap_s},
        }

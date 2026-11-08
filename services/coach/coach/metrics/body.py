"""Body movement and posture observations from pose.frame events.

- Timestamp-aware One-Euro smoothing per joint; filters reset after gaps, tracking loss and
  2D/3D mode changes (the coordinate systems are not comparable).
- Movement is normalised by a stable body reference: the median torso length (mid-shoulder to
  mid-hip / center_shoulder to root) over the last few seconds.
- 2D: Vision's normalized coordinates are converted to pixel-proportional units with the image
  size first, so x and y distances are comparable. Angles are projected image-plane angles.
- 3D: model positions are relative to the root (hip); torso displacement needs the root's
  camera-relative position, otherwise it is reported as unavailable.
These are movement observations, not interpretations (no 'nervous gesture' labels).

Postures (`posture` in body.metrics; rules body.arms_crossed, body.face_touch, body.looking_down).
Each frame is measured in the person's own body frame, so camera distance, resolution, mirroring
and a sideways lean do not matter: `down` = unit vector mid-shoulder -> mid-hip (the torso axis),
`across` = right shoulder -> left shoulder, made perpendicular to it. Distances are in torso lengths
of that frame. Each reported value is the median over `posture_window_s` (1 s) and needs samples in
half of the window's frames, so one noisy keypoint neither starts nor resets a rule.
- Arms crossed: each wrist's position across the body midline, signed so that > 0 means it is on
  the other side (left wrist right of the midline and vice versa). Folded arms put each wrist near
  the opposite elbow, ~0.3-0.5 torso lengths across; clasped hands or a clicker held in front stay
  on their own sides. `arms_cross` is the smaller of the two (both must cross) and counts only in
  the chest zone: both wrists between the shoulder line and 80 % of the way down to the hips, and
  within 0.8 torso lengths of the midline (folded against the body, not reaching across). A wrist
  hidden under the other arm falls below the keypoint confidence: the measure is then unavailable.
- Face touch: distance from the nearer wrist to the nearest face point (nose, eyes, ears). The
  wrist is about a hand length (~0.35 torso lengths) from the fingertips, so a hand on the chin,
  nose, cheek or ear gives ~0.2-0.35, while gestures at chest height stay above ~0.5. 2D has no
  depth: a hand held in front of the face counts too; the sustain filters hands passing by.
- Looking down: head pitch proxy = how far the nose is below the ear line, along the torso axis.
  The nose tip is ~10 cm in front of the ears, so tilting the head down by a moves it down by about
  10 cm * sin(a) relative to them (~0.07 torso lengths at 20 degrees), more than for any other face
  point (the eyes are only ~2.5 cm behind the nose tip). Without an ear in half the window, the
  nose's height relative to the shoulder line is used instead (less specific: shrugging moves it).
  The absolute value depends on camera height and the person, so the rule compares it with a
  head-up reference: a low percentile (p20) of the same measure over the last 60 s, which stays
  'head up' as long as the presenter looks up at least ~20 % of the time. The reference survives
  short tracking losses and restarts on a 2D/3D switch. A median compared with a low percentile
  reads slightly above 0 with the head still (keypoint jitter); the thresholds allow for that.
3D frames have no face points: arms crossed works the same way (root-relative meters); face touch
and looking down are reported as unavailable.
"""

from __future__ import annotations

import math
from collections import deque
from statistics import median

from coach.config import PoseConfig

KEY_2D = ("left_shoulder", "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist",
          "left_hip", "right_hip")
KEY_3D = KEY_2D + ("root", "center_shoulder")
FACE_2D = ("nose", "left_eye", "right_eye", "left_ear", "right_ear")   # postures only, not in the joint ratio
SIDES = ("left", "right")
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


def _sub(a: Vec, b: Vec) -> Vec:
    return tuple(p - q for p, q in zip(a, b))


def _dot(a: Vec, b: Vec) -> float:
    return sum(p * q for p, q in zip(a, b))


def _unit(v: Vec) -> Vec | None:
    n = math.sqrt(_dot(v, v))
    return None if n < 1e-9 else tuple(c / n for c in v)


def _percentile(values: list[float], pct: float) -> float:
    ordered = sorted(values)
    return ordered[round(pct / 100 * (len(ordered) - 1))]


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
        self._pitch: deque[tuple[float, float | None, float]] = deque(maxlen=4000)  # (t, ears, shoulders)
        self._roll: deque[tuple[float, float]] = deque(maxlen=4000)  # (t, head roll in degrees)
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
            self._pitch.clear()
            self._roll.clear()
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
        self.history.append({"t": t, "wrists": rel, "center": center,
                             "posture": self._posture_sample(t, smoothed, mode, length)})
        return True

    def _posture_sample(self, t: float, j: dict[str, Vec], mode: str, length: float) -> dict:
        """One frame's posture measures, in torso lengths (keys missing where joints are missing)."""
        out: dict = {}
        ends = self._torso_ends(j, mode)
        down = _unit(_sub(ends[1], ends[0])) if ends else None
        if down is None:
            return out
        top = ends[0]
        if "left_shoulder" in j and "right_shoulder" in j and all(f"{s}_wrist" in j for s in SIDES):
            side = _sub(j["left_shoulder"], j["right_shoulder"])                     # towards the person's left
            across = _unit(_sub(side, tuple(_dot(side, down) * c for c in down)))   # perpendicular to the torso
            if across is not None:
                cfg = self.cfg
                lateral = {s: _dot(_sub(j[f"{s}_wrist"], top), across) / length for s in SIDES}
                for s in SIDES:
                    out[f"cross_{s}"] = -lateral[s] if s == "left" else lateral[s]    # > 0: on the other side
                    out[f"height_{s}"] = _dot(_sub(j[f"{s}_wrist"], top), down) / length
                out["arms_cross"] = min(out["cross_left"], out["cross_right"])
                out["arms_zone"] = all(cfg.arms_crossed_min_height <= out[f"height_{s}"] <= cfg.arms_crossed_max_height
                                       and abs(lateral[s]) <= cfg.arms_crossed_max_reach for s in SIDES)
        if mode != "2d":
            return out
        face = [j[name] for name in FACE_2D if name in j]
        wrists = [j[f"{s}_wrist"] for s in SIDES if f"{s}_wrist" in j]
        if face and wrists:
            out["face"] = min(_dist(w, f) for w in wrists for f in face) / length
        if "nose" in j:
            ears = [j[name] for name in ("left_ear", "right_ear") if name in j]
            if ears:
                ear_line = tuple(sum(c) / len(ears) for c in zip(*ears))
                out["pitch_ears"] = _dot(_sub(j["nose"], ear_line), down) / length
            out["pitch_shoulders"] = _dot(_sub(j["nose"], top), down) / length
            self._pitch.append((t, out.get("pitch_ears"), out["pitch_shoulders"]))
            while self._pitch and self._pitch[0][0] < t - self.cfg.head_pitch_reference_window_s:
                self._pitch.popleft()
        if "left_shoulder" in j and "right_shoulder" in j:
            shoulders = _sub(j["left_shoulder"], j["right_shoulder"])
            # Head tilt: signed angle (degrees) of the eye line (the ear line without both eyes) against the
            # shoulder line. Measured against the shoulders, a lean of the whole body does not count.
            pair = next((p for p in (("left_eye", "right_eye"), ("left_ear", "right_ear")) if p[0] in j and p[1] in j), None)
            if pair:
                head = _sub(j[pair[0]], j[pair[1]])
                out["roll"] = math.degrees(math.atan2(shoulders[0] * head[1] - shoulders[1] * head[0], _dot(shoulders, head)))
                self._roll.append((t, out["roll"]))
                while self._roll and self._roll[0][0] < t - self.cfg.head_roll_reference_window_s:
                    self._roll.popleft()
            # Hand at a pocket (candidate): the wrist close to its own hip (in shoulder widths), at hip height,
            # with the elbow bent (a relaxed hanging arm is nearly straight and its wrist sits further out).
            width = _dist(j["left_shoulder"], j["right_shoulder"])
            cfg = self.cfg
            for s in SIDES if width > 1e-6 else ():
                hip, elbow, shoulder, wrist = (j.get(f"{s}_{n}") for n in ("hip", "elbow", "shoulder", "wrist"))
                if hip is None or elbow is None or shoulder is None:
                    continue
                if wrist is None:
                    if cfg.hands_pocket_count_hidden and _dot(_sub(elbow, top), down) / length >= 0.45:
                        out[f"pocket_{s}"] = True       # wrist not visible, arm down along the body
                    continue
                d = _dist(wrist, hip) / width
                below = _dot(_sub(wrist, hip), down) / length
                bend = _angle(shoulder, elbow, wrist)
                out[f"pocket_dist_{s}"], out[f"pocket_rel_{s}"] = d, tuple(c / length for c in _sub(wrist, hip))
                if bend is not None:
                    out[f"elbow_{s}"] = bend
                out[f"pocket_{s}"] = (d <= cfg.hands_pocket_max_distance and bend is not None and bend <= cfg.hands_pocket_max_elbow_deg
                                      and cfg.hands_pocket_min_below <= below <= cfg.hands_pocket_max_below)
        return out

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
    def _torso_ends(joints: dict[str, Vec], mode: str) -> tuple[Vec, Vec] | None:
        """(top, bottom) of the torso axis: center_shoulder and root (3D), or mid-shoulder and mid-hip."""
        if mode == "3d" and "center_shoulder" in joints and "root" in joints:
            return joints["center_shoulder"], joints["root"]
        if all(k in joints for k in ("left_shoulder", "right_shoulder", "left_hip", "right_hip")):
            return (_mid(joints["left_shoulder"], joints["right_shoulder"]),
                    _mid(joints["left_hip"], joints["right_hip"]))
        return None

    @classmethod
    def _torso(cls, joints: dict[str, Vec], mode: str) -> tuple[Vec, float] | None:
        ends = cls._torso_ends(joints, mode)
        if ends is None:
            return None
        top, bottom = ends
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
            "posture": self._posture(now, present),
            "frames_in_window": len(frames),
            "smoothing": {"method": "one_euro", "min_cutoff_hz": self.cfg.smoothing_min_cutoff_hz,
                          "beta": self.cfg.smoothing_beta, "reset_after_gap_s": self.cfg.reset_after_gap_s},
        }

    def _posture(self, now: float, present: bool) -> dict:
        """Medians of the per-frame posture measures over the posture window, and the head-up reference."""
        cfg = self.cfg
        out: dict = {"unit": "torso_lengths", "window_s": cfg.posture_window_s,
                     "arms_crossed": None, "arms_cross": None, "arms_in_zone": None,
                     "wrist_cross": {"left": None, "right": None}, "wrist_height": {"left": None, "right": None},
                     "face_touch": None, "face_touch_distance": None,
                     "looking_down": None, "head_pitch": None, "head_pitch_source": None,
                     "head_pitch_reference": None, "head_pitch_delta": None}
        if self.mode == "3d":
            out["note"] = "face_touch, looking_down, head_tilt and hands_in_pockets need 2D keypoints"
        frames = [h["posture"] for h in self.history if now - h["t"] <= cfg.posture_window_s] if present else []
        need = max(2.0, len(frames) / 2)

        def med(key: str) -> float | None:
            values = [p[key] for p in frames if p.get(key) is not None]
            return median(values) if len(values) >= need else None

        def r3(value: float | None) -> float | None:
            return None if value is None else round(value, 3)

        for s in SIDES:
            out["wrist_cross"][s], out["wrist_height"][s] = r3(med(f"cross_{s}")), r3(med(f"height_{s}"))
        cross = med("arms_cross")
        if cross is not None:
            zone = [p["arms_zone"] for p in frames if "arms_zone" in p]
            out["arms_cross"], out["arms_in_zone"] = round(cross, 3), sum(zone) >= len(zone) / 2
            out["arms_crossed"] = out["arms_in_zone"] and cross >= cfg.arms_crossed_min_cross
        face = med("face")
        if face is not None:
            out["face_touch_distance"], out["face_touch"] = round(face, 3), face <= cfg.face_touch_max_distance

        # Head tilted sideways: roll vs this person's usual roll (median over a longer window).
        out.update({"head_tilt": None, "head_roll": None, "head_roll_reference": None, "head_roll_delta": None})
        roll = med("roll")
        if roll is not None:
            out["head_roll"] = round(roll, 1)
            rolls = [(tt, v) for tt, v in self._roll if now - tt <= cfg.head_roll_reference_window_s]
            if len(rolls) >= 2 and rolls[-1][0] - rolls[0][0] >= cfg.head_roll_reference_min_s:
                reference = median(v for _, v in rolls)
                delta = abs(roll - reference)
                out["head_roll_reference"], out["head_roll_delta"] = round(reference, 1), round(delta, 1)
                out["head_tilt"] = delta >= cfg.head_tilt_min_deg
        # Hands in pockets (likely): the candidate held in most of the window, and the wrist still.
        pockets: dict = {"left": None, "right": None}
        out.update({"hand_in_pocket": pockets, "hand_pocket_distance": {"left": None, "right": None},
                    "elbow_angle": {"left": None, "right": None}, "hands_in_pockets": None, "hands_in_pockets_count": None})
        for s in SIDES:
            flags = [p[f"pocket_{s}"] for p in frames if f"pocket_{s}" in p]
            if len(flags) < need:
                continue
            rel = [p[f"pocket_rel_{s}"] for p in frames if f"pocket_rel_{s}" in p]
            centre = tuple(median(c) for c in zip(*rel)) if rel else None
            still = centre is None or max(_dist(r, centre) for r in rel) <= cfg.hands_pocket_max_motion
            pockets[s] = sum(flags) >= 0.6 * len(flags) and still
            out["hand_pocket_distance"][s] = r3(med(f"pocket_dist_{s}"))
            bend = med(f"elbow_{s}")
            out["elbow_angle"][s] = None if bend is None else round(bend, 1)
        known = [v for v in pockets.values() if v is not None]
        if known:
            out["hands_in_pockets_count"] = sum(1 for v in known if v)
            out["hands_in_pockets"] = out["hands_in_pockets_count"] > 0

        source = "ears" if med("pitch_ears") is not None else "shoulders"
        pitch = med(f"pitch_{source}")
        if pitch is None:
            return out
        out["head_pitch"], out["head_pitch_source"] = round(pitch, 3), source
        column = 1 if source == "ears" else 2
        history = [(row[0], row[column]) for row in self._pitch
                   if row[column] is not None and now - row[0] <= cfg.head_pitch_reference_window_s]
        if len(history) >= 2 and history[-1][0] - history[0][0] >= cfg.head_pitch_reference_min_s:
            reference = _percentile([v for _, v in history], cfg.head_pitch_reference_percentile)
            out["head_pitch_reference"], out["head_pitch_delta"] = round(reference, 3), round(pitch - reference, 3)
            out["looking_down"] = pitch - reference >= cfg.looking_down_min_delta
        return out

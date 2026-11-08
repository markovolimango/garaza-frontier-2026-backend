"""Heart-rate observations from authorized Apple Watch samples (or labelled simulations).

- A *session reference* is the median of fresh samples collected during an explicit quiet
  calibration period. It is not a clinical resting heart rate.
- Freshness is judged from the sample's measurement time, not its arrival time. Samples that
  arrive late (queued WatchConnectivity transfers) are stored but never shown as current.
- No HRV is computed from bpm samples. An HRV value is passed through only if the device sent
  a HealthKit SDNN sample, and it is contextual only.
- Nothing here infers stress, anxiety or any emotional state.
"""

from __future__ import annotations

from collections import deque
from statistics import median

from coach.config import HeartConfig

REFERENCE_LABEL = "session reference from a quiet calibration period (not a clinical resting heart rate)"


class HeartTracker:
    def __init__(self, cfg: HeartConfig):
        self.cfg = cfg
        self.samples: deque[dict] = deque(maxlen=5000)
        self.calibration = {"status": "not_started", "started_at_t": None, "ends_at_t": None}
        self.reference_bpm: float | None = None
        self.reference_samples = 0
        self.watch_reachable: bool | None = None
        self.watch_authorized: bool | None = None
        self.last_hrv: dict | None = None
        self.late_samples = 0

    def on_sample(self, measured_t: float, arrived_t: float, payload: dict, event_id: str) -> bool:
        """Store a sample. Returns True if it was fresh when it arrived."""
        fresh = arrived_t - measured_t <= self.cfg.fresh_max_age_s
        if not fresh:
            self.late_samples += 1
        self.samples.append({"t": measured_t, "arrived_t": arrived_t, "bpm": float(payload["bpm"]),
                             "mode": payload["collection_mode"], "delivery": payload["delivery"],
                             "fresh_on_arrival": fresh, "event_id": event_id})
        if payload.get("hrv_sdnn_ms") is not None:
            self.last_hrv = {"status": "contextual", "sdnn_ms": payload["hrv_sdnn_ms"], "t": measured_t,
                             "note": "HealthKit SDNN passthrough; not computed by this service"}
        if payload.get("availability") == "unauthorized":
            self.watch_authorized = False
        return fresh

    def on_watch_status(self, watch: dict) -> None:
        if "reachable" in watch:
            self.watch_reachable = bool(watch["reachable"])
        if "authorized" in watch and watch["authorized"] is not None:
            self.watch_authorized = bool(watch["authorized"])

    # ------------------------------------------------------------------ calibration
    def start_calibration(self, now: float, duration_s: float | None) -> dict:
        duration = duration_s or self.cfg.calibration_s
        self.calibration = {"status": "collecting", "started_at_t": now, "ends_at_t": now + duration}
        self.reference_bpm, self.reference_samples = None, 0
        return self.calibration

    def update_calibration(self, now: float) -> bool:
        """Finish calibration when its window has passed. Returns True on a status change."""
        cal = self.calibration
        if cal["status"] != "collecting" or now < cal["ends_at_t"]:
            return False
        usable = [s["bpm"] for s in self.samples
                  if cal["started_at_t"] <= s["t"] <= cal["ends_at_t"] and s["fresh_on_arrival"]]
        self.reference_samples = len(usable)
        if len(usable) >= self.cfg.min_reference_samples:
            self.reference_bpm = round(median(usable), 1)
            cal["status"] = "ready"
        else:
            cal["status"] = "insufficient_data"
        return True

    # ------------------------------------------------------------------ outputs
    def _fresh(self, now: float) -> list[dict]:
        return [s for s in self.samples if s["fresh_on_arrival"] and 0 <= now - s["t"] <= self.cfg.fresh_max_age_s]

    def latest(self) -> dict | None:
        candidates = [s for s in self.samples if s["fresh_on_arrival"]]
        return max(candidates, key=lambda s: s["t"]) if candidates else None

    def availability(self, now: float) -> str:
        if self.watch_authorized is False:
            return "unauthorized"
        latest = self.latest()
        if self.watch_reachable is False and (latest is None or now - latest["t"] > self.cfg.fresh_max_age_s):
            return "watch_unreachable"
        if latest is None:
            return "no_data"
        return "available" if now - latest["t"] <= self.cfg.fresh_max_age_s else "stale"

    def evaluate(self, now: float) -> dict:
        window = [s for s in self._fresh(now) if now - s["t"] <= self.cfg.evaluation_window_s]
        recent = round(median(s["bpm"] for s in window), 1) if window else None
        enough = len(window) >= self.cfg.min_fresh_samples
        delta = round(recent - self.reference_bpm, 1) if (recent is not None and self.reference_bpm is not None) else None
        latest = self.latest()
        availability = self.availability(now)
        quality = "good"
        if availability != "available":
            quality = "stale" if availability == "stale" else "unavailable"
        elif not enough or self.reference_bpm is None:
            quality = "insufficient_data"
        above = None
        if quality == "good" and delta is not None:
            above = delta >= self.cfg.rise_threshold_bpm
        cal = self.calibration
        return {
            "availability": availability,
            "latest": None if latest is None else {
                "bpm": latest["bpm"], "measured_at_t": latest["t"], "age_s": round(now - latest["t"], 1),
                "fresh": now - latest["t"] <= self.cfg.fresh_max_age_s, "collection_mode": latest["mode"],
                "delivery": latest["delivery"]},
            "reference": {"status": cal["status"], "bpm": self.reference_bpm, "samples": self.reference_samples,
                          "min_samples": self.cfg.min_reference_samples, "label": REFERENCE_LABEL,
                          "started_at_t": cal["started_at_t"], "ends_at_t": cal["ends_at_t"]},
            "delta_from_reference_bpm": delta,
            "above_reference": above,
            "hrv": self.last_hrv or {"status": "unavailable"},
            "_rule": {"recent_median": recent, "fresh_in_window": len(window), "enough": enough, "quality": quality,
                      "evidence": [s["event_id"] for s in window][-10:]},
        }

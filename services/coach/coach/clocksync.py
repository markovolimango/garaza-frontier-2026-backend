"""Device-to-server clock offset estimation (NTP-style 4-timestamp handshake).

Device sends clock.ping{t0}; server replies clock.pong{t0, t1, t2}; device records t3 and
sends clock.sample{t0, t1, t2, t3}. All values are epoch milliseconds on the respective clock.

    offset = ((t1 - t0) + (t2 - t3)) / 2      # server_time - device_time
    rtt    = (t3 - t0) - (t2 - t1)

The sample with the smallest round trip among recent samples is used; its uncertainty is
rtt / 2 plus a drift allowance that grows with the sample's age (assumed <= 100 ppm).
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

DRIFT_PPM = 100.0
BASE_MARGIN_MS = 1.0


@dataclass(frozen=True)
class ClockSample:
    offset_ms: float
    rtt_ms: float
    at_s: float  # server time when computed


@dataclass(frozen=True)
class ClockEstimate:
    offset_ms: float
    uncertainty_ms: float
    samples: int
    best_rtt_ms: float


class ClockEstimator:
    def __init__(self, keep: int = 16, max_age_s: float = 600.0, max_rtt_ms: float = 2000.0):
        self._samples: deque[ClockSample] = deque(maxlen=keep)
        self.max_age_s = max_age_s
        self.max_rtt_ms = max_rtt_ms

    def add(self, t0: float, t1: float, t2: float, t3: float, now_s: float) -> ClockSample:
        rtt = (t3 - t0) - (t2 - t1)
        if rtt < 0 or t2 < t1 or t3 < t0:
            raise ValueError("inconsistent clock sample timestamps")
        if rtt > self.max_rtt_ms:
            raise ValueError(f"round trip {rtt:.0f} ms too long for a useful estimate")
        sample = ClockSample(offset_ms=((t1 - t0) + (t2 - t3)) / 2.0, rtt_ms=rtt, at_s=now_s)
        self._samples.append(sample)
        return sample

    def estimate(self, now_s: float) -> ClockEstimate | None:
        recent = [s for s in self._samples if now_s - s.at_s <= self.max_age_s]
        if not recent:
            return None
        best = min(recent, key=lambda s: s.rtt_ms)
        age_ms = max(0.0, (now_s - best.at_s) * 1000.0)
        uncertainty = best.rtt_ms / 2.0 + BASE_MARGIN_MS + age_ms * DRIFT_PPM / 1e6
        return ClockEstimate(best.offset_ms, uncertainty, len(recent), best.rtt_ms)

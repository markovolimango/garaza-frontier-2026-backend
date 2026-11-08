"""Time helpers. Internally all times are float epoch seconds in the *server* clock domain."""

from __future__ import annotations

import time
from datetime import datetime, timezone


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def to_iso(value: datetime | float) -> str:
    """UTC ISO 8601 with millisecond precision and a 'Z' suffix."""
    if isinstance(value, (int, float)):
        value = datetime.fromtimestamp(value, timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch(value: datetime) -> float:
    if value.tzinfo is None:
        raise ValueError("timestamp must include a timezone")
    return value.timestamp()


class SystemClock:
    """Live sessions: 'now' is the server wall clock."""

    def now(self) -> float:
        return time.time()


class EventTimeClock:
    """Simulation/replay sessions: 'now' is the latest corrected event time seen (deterministic)."""

    def __init__(self, start: float):
        self._now = start

    def now(self) -> float:
        return self._now

    def observe(self, t: float) -> None:
        if t > self._now:
            self._now = t


class ManualClock:
    """Tests: time moves only when told to."""

    def __init__(self, start: float = 1_800_000_000.0):
        self._now = start

    def now(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds

    def observe(self, t: float) -> None:  # same interface as EventTimeClock
        if t > self._now:
            self._now = t

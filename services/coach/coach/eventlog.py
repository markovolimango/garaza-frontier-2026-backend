"""Bounded per-session event history with server cursors.

Two ring buffers share one cursor sequence: pose frames (short history, high rate) and all
other events (longer history). Resuming after a cursor is exact for non-pose events while
they are retained; once a needed non-pose event has been evicted the request is answered
with an explicit history_expired. Pose frames are best-effort: evicted frames are skipped.
"""

from __future__ import annotations

from collections import deque
from typing import Iterable

POSE_TYPE = "pose.frame"


def type_matches(event_type: str, patterns: Iterable[str] | None) -> bool:
    if not patterns:
        return True
    for pattern in patterns:
        if pattern == event_type or (pattern.endswith(".*") and event_type.startswith(pattern[:-1])):
            return True
    return False


class EventLog:
    def __init__(self, max_events: int, max_pose: int):
        self._main: deque[dict] = deque(maxlen=max_events)
        self._pose: deque[dict] = deque(maxlen=max_pose)
        self.head = 0                  # last assigned cursor
        self.evicted_through = 0       # highest cursor of an evicted non-pose event
        self.evicted_pose = 0

    def append(self, event: dict) -> int:
        self.head += 1
        event["cursor"] = self.head
        ring = self._pose if event["event_type"] == POSE_TYPE else self._main
        if len(ring) == ring.maxlen:
            evicted = ring[0]
            if ring is self._main:
                self.evicted_through = evicted["cursor"]
            else:
                self.evicted_pose += 1
        ring.append(event)
        return self.head

    @property
    def oldest_cursor(self) -> int:
        """Smallest after_cursor for which non-pose history is complete."""
        return self.evicted_through

    def expired(self, after_cursor: int) -> bool:
        return after_cursor < self.evicted_through

    def since(self, after_cursor: int, limit: int | None = None,
              types: Iterable[str] | None = None, up_to: int | None = None) -> list[dict]:
        upper = self.head if up_to is None else up_to
        merged = [e for e in self._main if after_cursor < e["cursor"] <= upper]
        if type_matches(POSE_TYPE, types):
            merged += [e for e in self._pose if after_cursor < e["cursor"] <= upper]
        merged.sort(key=lambda e: e["cursor"])
        if types:
            merged = [e for e in merged if type_matches(e["event_type"], types)]
        return merged[:limit] if limit else merged

    def all_events(self) -> list[dict]:
        return self.since(0)

    def counts(self) -> dict:
        return {"retained_events": len(self._main), "retained_pose_frames": len(self._pose),
                "head_cursor": self.head, "oldest_complete_after_cursor": self.evicted_through,
                "evicted_pose_frames": self.evicted_pose}

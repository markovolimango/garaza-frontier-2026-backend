"""Authoritative session state: lifecycle, ingest, metrics, coaching and publishing.

Lifecycle: created -> running <-> paused -> ended (stop is allowed from created/running/paused).

Ingest path (synchronous checks, then a bounded two-lane queue):
  validate -> authorize source -> de-duplicate -> sequence tracking -> clock correction ->
  staleness -> enqueue (high lane: control, speech, heart rate; pose lane: oldest dropped first)
A single worker per session processes the queue (high lane first), appends every event to the
cursor log, updates trackers and evaluates coaching. Cursor order is processing order; use
`timing.corrected_captured_at` for time order.
"""

from __future__ import annotations

import asyncio
import uuid
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from pydantic import ValidationError

from coach import SCHEMA_VERSION
from coach.clocksync import ClockEstimator
from coach.coaching import CoachingEngine, build_evals
from coach.config import SessionConfig, Settings, merge_config
from coach.eventlog import EventLog, type_matches
from coach.metrics.body import BodyTracker
from coach.metrics.heart import HeartTracker
from coach.metrics.speech import SpeechTracker
from coach.timeutil import EventTimeClock, SystemClock, epoch, to_iso
from coach.wire import (DEVICE_EVENT_TYPES, PAYLOAD_MODELS, PRIORITY_HIGH, EventIn, EventType,
                        SERVER_PAYLOAD_MODELS)

SERVER_SOURCE_ID = "coach-server"
RELAY_MARGIN_MS = 500.0          # assumed extra uncertainty for relayed (Watch) clocks
FUTURE_TOLERANCE_S = 5.0
TRANSITIONS = {
    "start": ({"created"}, "running"),
    "pause": ({"running"}, "paused"),
    "resume": ({"paused"}, "running"),
    "stop": ({"created", "running", "paused"}, "ended"),
}
SPEECH_TYPES = {EventType.speech_activity, EventType.speech_transcript_partial, EventType.speech_transcript_final}


class SessionError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, details: dict | None = None):
        super().__init__(message)
        self.code, self.message, self.status, self.details = code, message, status, details


@dataclass
class DeviceInfo:
    device_id: str
    kind: str
    simulated: bool = False
    name: str | None = None
    connected: bool = False
    last_seen: float | None = None
    clock: ClockEstimator = field(default_factory=ClockEstimator)


class DeviceRegistry:
    """Devices known to this server process (clock estimates outlive single sessions)."""

    def __init__(self) -> None:
        self.devices: dict[str, DeviceInfo] = {}

    def get(self, device_id: str, kind: str = "unknown", simulated: bool = False) -> DeviceInfo:
        info = self.devices.get(device_id)
        if info is None:
            info = self.devices[device_id] = DeviceInfo(device_id, kind, simulated)
        return info


@dataclass
class _Stream:
    highest: int = -1
    missing: OrderedDict = field(default_factory=OrderedDict)
    gaps_total: int = 0
    out_of_order: int = 0
    regressions: int = 0
    last_gap_warning: float = -1e9


def _strip(obj: Any) -> Any:
    """Remove internal keys and convert *_t epoch floats into *_at ISO strings."""
    if isinstance(obj, dict):
        out = {}
        for key, value in obj.items():
            if key.startswith("_"):
                continue
            if key.endswith("_t") and isinstance(value, (int, float)) and not isinstance(value, bool):
                out[key[:-2] if key.endswith("_at_t") else key[:-2] + "_at"] = to_iso(value)
            else:
                out[key] = _strip(value)
        return out
    if isinstance(obj, list):
        return [_strip(v) for v in obj]
    return obj


class Session:
    def __init__(self, settings: Settings, registry: DeviceRegistry, *, label: str | None, mic_source: str,
                 timeline: str, simulated: bool, config: dict | None, clock=None,
                 on_feedback: Callable[["Session", dict], None] | None = None):
        self.id = f"ses_{uuid.uuid4().hex[:16]}"
        self.settings, self.registry = settings, registry
        self.label, self.mic_source, self.timeline, self.simulated = label, mic_source, timeline, simulated
        self.config: SessionConfig = merge_config(config)
        self.clock = clock or (SystemClock() if timeline == "live" else EventTimeClock(SystemClock().now()))
        self.created_at = self.clock.now()
        self.last_activity_wall = SystemClock().now()
        self.ended_wall: float | None = None
        self.started_at: float | None = None
        self.ended_at: float | None = None
        self.state = "created"
        self.running: list[list] = []
        self.log = EventLog(settings.event_buffer, settings.pose_buffer)
        self.body = BodyTracker(self.config.pose)
        self.speech = SpeechTracker(self.config.speech)
        self.heart = HeartTracker(self.config.heart)
        self.coach = CoachingEngine(self.config.coaching)
        self.on_feedback = on_feedback
        self.mic_device_id: str | None = None
        self.devices: dict[str, dict] = {}
        self._seen: OrderedDict[tuple[str, str], None] = OrderedDict()
        self._streams: dict[str, _Stream] = {}
        self._high: deque = deque()
        self._pose: deque = deque()
        self._wake = asyncio.Event()
        self._idle = asyncio.Event()
        self._idle.set()
        self._worker: asyncio.Task | None = None
        self._server_seq = 0
        self._arrivals = 0
        self.subscribers: set = set()
        self.control_listeners: set[Callable[[dict], None]] = set()
        self.counters = {k: 0 for k in (
            "received", "accepted", "duplicates", "rejected", "dropped_pose_frames", "sequence_gaps",
            "out_of_order", "late", "clock_suspect", "processed", "subscriber_drops", "late_pose_not_smoothed",
            "evaluation_errors")}
        self._last_body_emit = -1e9
        self._last_speech_emit = -1e9
        self._last_body_state: str | None = None
        self._last_heart_availability: str | None = None
        self._last_warning: dict[str, float] = {}
        self._cache: dict[str, tuple[float, dict]] = {}
        self._dirty: set[str] = {"body", "speech", "heart"}
        self.backpressure = False
        self.feedback_count: dict[str, int] = {}
        self._publish(EventType.session_state, {"state": "created", "previous": None, "reason": "created"})

    # ======================================================================= lifecycle
    def public(self) -> dict:
        return {
            "schema_version": SCHEMA_VERSION, "session_id": self.id, "label": self.label, "state": self.state,
            "timeline": self.timeline, "mic_source": self.mic_source, "simulated": self.simulated,
            "created_at": to_iso(self.created_at),
            "started_at": to_iso(self.started_at) if self.started_at else None,
            "ended_at": to_iso(self.ended_at) if self.ended_at else None,
            "head_cursor": self.log.head, "config": self.config.model_dump(),
        }

    def transition(self, action: str, reason: str | None = None) -> dict:
        allowed, target = TRANSITIONS[action]
        if self.state not in allowed:
            raise SessionError("invalid_transition", f"cannot {action} a session in state '{self.state}'", 409,
                               {"state": self.state, "action": action, "allowed_from": sorted(allowed)})
        now = self.clock.now()
        previous, self.state = self.state, target
        if target == "running":
            self.started_at = self.started_at or now
            self.running.append([now, None])
        elif self.running and self.running[-1][1] is None:
            self.running[-1][1] = now
        if target == "ended":
            self.ended_at = now
            self.ended_wall = SystemClock().now()
        self.last_activity_wall = SystemClock().now()
        self._dirty.update({"body", "speech", "heart"})
        self._publish(EventType.session_state, {"state": target, "previous": previous, "reason": reason or action})
        for listener in list(self.control_listeners):
            listener(self.control_message())
        return self.public()

    def control_message(self) -> dict:
        cfg = self.config
        return {"type": "session", "session": {
            "session_id": self.id, "state": self.state, "mic_source": self.mic_source, "simulated": self.simulated,
            "timeline": self.timeline, "language": cfg.speech.language, "pose_rate_hz": cfg.pose.target_rate_hz}}

    def running_intervals(self, now: float) -> list[tuple[float, float]]:
        return [(s, e if e is not None else now) for s, e in self.running]

    def running_segments(self) -> list[tuple[float, float | None]]:
        """Running segments with None for the open one (speech metrics cache key)."""
        return [(s, e) for s, e in self.running]

    # ======================================================================= ingest
    def accept(self, event: EventIn, principal_device: str | None, connection_kind: str | None) -> dict:
        """Synchronous admission. Returns {"status": accepted|duplicate|rejected|dropped, ...}."""
        self.counters["received"] += 1
        etype = event.event_type
        src = event.source
        key = (src.device_id, event.event_id)
        if self.state == "ended":
            return self._reject(event, "session_ended", "session has ended")
        if etype not in DEVICE_EVENT_TYPES:
            return self._reject(event, "type_not_allowed", f"{etype.value} is server-generated")
        if principal_device is not None:  # None = operator/replay path
            relayed_watch = (src.kind.value == "watch" and src.relay_device_id == principal_device
                             and connection_kind in ("iphone", "simulator"))
            if src.device_id != principal_device and not relayed_watch:
                return self._reject(event, "source_mismatch", "source.device_id does not match the authenticated device")
            if connection_kind == "simulator" and not src.simulated:
                return self._reject(event, "simulated_flag_required", "simulator credentials must mark events simulated")
            if connection_kind != "simulator" and src.simulated:
                return self._reject(event, "simulated_flag_not_allowed", "real device credentials cannot send simulated data")
        if src.simulated != self.simulated:
            return self._reject(event, "simulation_mismatch",
                                "simulated and real measurements are never mixed in one session")
        try:
            payload = PAYLOAD_MODELS[etype].model_validate(event.payload).model_dump(mode="json")
        except ValidationError as exc:
            return self._reject(event, "invalid_payload", "payload validation failed",
                                {"errors": exc.errors(include_url=False, include_context=False)[:5]})
        if etype in SPEECH_TYPES:
            expected = "iphone" if self.mic_source == "iphone" else "mac" if self.mic_source == "mac" else None
            if expected is None or src.kind.value != expected:
                return self._reject(event, "not_authoritative_microphone",
                                    f"session microphone source is '{self.mic_source}'")
            if self.mic_device_id is None:
                self.mic_device_id = src.device_id
            elif self.mic_device_id != src.device_id:
                return self._reject(event, "not_authoritative_microphone",
                                    f"device {self.mic_device_id} is the authoritative microphone")
        if key in self._seen:
            self.counters["duplicates"] += 1
            return {"status": "duplicate", "event_id": event.event_id}
        self._seen[key] = None
        if len(self._seen) > 50_000:
            self._seen.popitem(last=False)

        out_of_order = self._track_sequence(src.device_id, event.sequence)
        timing, corrected = self._timing(event, out_of_order)
        now = self.clock.now()  # event_time sessions advance at processing time, not here
        if corrected > now + FUTURE_TOLERANCE_S:
            self.counters["clock_suspect"] += 1
            self._warn("clock_suspect", f"{src.device_id} timestamps are ahead of the server clock",
                       {"device_id": src.device_id, "ahead_s": round(corrected - now, 3)})
        staleness = {EventType.pose_frame: self.config.pose.stale_after_s,
                     EventType.heart_rate_sample: self.config.heart.fresh_max_age_s}.get(etype, self.config.speech.stale_after_s)
        if now - corrected > staleness:
            timing["late"] = True
            self.counters["late"] += 1
        dev = self.devices.setdefault(src.device_id, {"device_id": src.device_id, "kind": src.kind.value,
                                                       "simulated": src.simulated, "relay_device_id": src.relay_device_id,
                                                       "last_event_at_t": None, "events": 0, "status": None})
        dev["last_event_at_t"], dev["events"] = now, dev["events"] + 1
        self.last_activity_wall = SystemClock().now()
        self._arrivals += 1
        item = {"event": event, "payload": payload, "timing": timing, "corrected": corrected,
                "received_at": SystemClock().now(), "n": self._arrivals}
        if etype in PRIORITY_HIGH:
            if len(self._high) >= self.settings.ingest_high_queue:
                del self._seen[key]
                return self._reject(event, "queue_full", "control queue full; retry later", retryable=True)
            self._high.append(item)
        else:
            if len(self._pose) >= self.settings.ingest_pose_queue:
                self._pose.popleft()
                self.counters["dropped_pose_frames"] += 1
                self._warn("ingest_backpressure", "pose frames dropped: processing is behind",
                           {"dropped_pose_frames": self.counters["dropped_pose_frames"]})
            self._pose.append(item)
        self.counters["accepted"] += 1
        self._idle.clear()
        self._wake.set()
        return {"status": "accepted", "event_id": event.event_id}

    def backpressure_level(self) -> float:
        return len(self._pose) / max(1, self.settings.ingest_pose_queue)

    def _reject(self, event: EventIn, code: str, message: str, details: dict | None = None,
                retryable: bool = False) -> dict:
        self.counters["rejected"] += 1
        return {"status": "rejected", "event_id": event.event_id, "code": code, "message": message,
                "details": details, "retryable": retryable}

    def _track_sequence(self, device_id: str, seq: int) -> bool:
        stream = self._streams.setdefault(device_id, _Stream())
        if seq > stream.highest:
            if stream.highest >= 0 and seq > stream.highest + 1:
                missing = range(stream.highest + 1, seq)
                stream.gaps_total += len(missing)
                self.counters["sequence_gaps"] += len(missing)
                for n in range(max(missing.start, missing.stop - 1000), missing.stop):  # bounded, even for huge jumps
                    stream.missing[n] = None
                while len(stream.missing) > 1000:
                    stream.missing.popitem(last=False)
                self._warn(f"sequence_gap:{device_id}", f"{len(missing)} event(s) missing from {device_id}",
                           {"device_id": device_id, "from_sequence": missing.start, "to_sequence": missing.stop - 1},
                           code="sequence_gap")
            stream.highest = seq
            return False
        if seq in stream.missing:
            del stream.missing[seq]
            stream.gaps_total -= 1
            self.counters["sequence_gaps"] -= 1
        else:
            stream.regressions += 1  # e.g. app restart reusing low sequence numbers
        stream.out_of_order += 1
        self.counters["out_of_order"] += 1
        return True

    def _timing(self, event: EventIn, out_of_order: bool) -> tuple[dict, float]:
        captured = epoch(event.captured_at)
        src = event.source
        estimate, basis, extra = None, "none", 0.0
        if src.relay_device_id:
            relay = self.registry.devices.get(src.relay_device_id)
            estimate = relay.clock.estimate(SystemClock().now()) if relay else None
            basis, extra = ("relay_assumed", RELAY_MARGIN_MS) if estimate else ("none", 0.0)
        else:
            info = self.registry.devices.get(src.device_id)
            estimate = info.clock.estimate(SystemClock().now()) if info else None
            basis = "handshake" if estimate else "none"
        offset = estimate.offset_ms if estimate else None
        corrected = captured + (offset or 0.0) / 1000.0
        timing = {"clock_basis": basis, "clock_offset_ms": None if offset is None else round(offset, 3),
                  "clock_uncertainty_ms": None if estimate is None else round(estimate.uncertainty_ms + extra, 3),
                  "corrected_captured_at": to_iso(corrected), "out_of_order": out_of_order, "late": False}
        return timing, corrected

    def correct(self, device_id: str, relay: str | None, value: datetime | str | None) -> float | None:
        """Map another device timestamp from a payload (e.g. audio_start_at) to the server clock."""
        if value is None:
            return None
        if isinstance(value, str):
            value = datetime.fromisoformat(value.replace("Z", "+00:00"))
        info = self.registry.devices.get(relay or device_id)
        estimate = info.clock.estimate(SystemClock().now()) if info else None
        return epoch(value) + ((estimate.offset_ms if estimate else 0.0) / 1000.0)

    # ======================================================================= processing
    def start_worker(self) -> None:
        if self._worker is None:
            self._worker = asyncio.get_running_loop().create_task(self._run(), name=f"session-{self.id}")

    async def _run(self) -> None:
        processed = 0
        while True:
            item = self._next()
            if item is None:
                self._idle.set()
                self._wake.clear()
                await self._wake.wait()
                continue
            self._process(item)
            processed += 1
            if processed % 25 == 0:
                await asyncio.sleep(0)

    def _next(self) -> dict | None:
        if self.timeline == "event_time" and self._high and self._pose:
            # Deterministic simulation/replay: arrival order, so event time never runs backwards.
            lane = self._high if self._high[0]["n"] < self._pose[0]["n"] else self._pose
            return lane.popleft()
        if self._high:
            return self._high.popleft()
        if self._pose:
            return self._pose.popleft()
        return None

    def process_pending(self) -> int:
        """Synchronous drain (tests, replay)."""
        count = 0
        while (item := self._next()) is not None:
            self._process(item)
            count += 1
        self._idle.set()
        return count

    async def drain(self, timeout: float = 5.0) -> None:
        if self._worker is None:
            self.process_pending()
            return
        await asyncio.wait_for(self._idle.wait(), timeout)

    def stop_worker(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            self._worker = None

    def _process(self, item: dict) -> None:
        event: EventIn = item["event"]
        payload, timing, t = item["payload"], item["timing"], item["corrected"]
        etype = event.event_type
        self.counters["processed"] += 1
        if isinstance(self.clock, EventTimeClock):
            self.clock.observe(t)
        out = {
            "schema_version": SCHEMA_VERSION, "cursor": 0, "event_id": event.event_id, "session_id": self.id,
            "source": event.source.model_dump(mode="json"), "sequence": event.sequence, "event_type": etype.value,
            "captured_at": to_iso(event.captured_at), "source_monotonic_ms": event.source_monotonic_ms,
            "received_at": to_iso(item["received_at"]), "timing": timing, "payload": payload,
        }
        self._append(out)
        now = self.clock.now()
        src = event.source
        if etype == EventType.pose_frame:
            if self.state == "running":
                if not self.body.update(t, payload, event.event_id):
                    self.counters["late_pose_not_smoothed"] += 1
                self._dirty.add("body")
        elif etype == EventType.speech_activity:
            self.speech.on_activity(t, payload, event.event_id)
            self._dirty.add("speech")
        elif etype in (EventType.speech_transcript_partial, EventType.speech_transcript_final):
            internal = dict(payload)
            internal["_audio_start_t"] = self.correct(src.device_id, src.relay_device_id, payload.get("audio_start_at"))
            self.speech.on_transcript(t, internal, etype == EventType.speech_transcript_final, event.event_id)
            self._dirty.add("speech")
        elif etype == EventType.heart_rate_sample:
            measured = self.correct(src.device_id, src.relay_device_id, payload["measured_at"])
            self.heart.on_sample(measured, now, payload, event.event_id)
            self._dirty.add("heart")
        elif etype == EventType.audio_playback:
            self.speech.on_playback(t, payload)
            self._dirty.add("speech")
        elif etype == EventType.device_status:
            dev = self.devices.get(payload.get("subject_device_id") or src.device_id)
            if dev is not None:
                dev["status"] = payload
            if payload.get("watch"):
                self.heart.on_watch_status(payload["watch"])
                self._dirty.add("heart")
        self.evaluate(now, triggered_by=etype)

    # ======================================================================= derived events
    def _component(self, name: str, now: float) -> dict:
        """Recomputed for every evaluation time: time-window results must not depend on when the
        previous evaluation happened (correctness and deterministic replay)."""
        cached = self._cache.get(name)
        if name not in self._dirty and cached and cached[0] == now:
            return cached[1]
        if name == "body":
            value = self.body.metrics(now)
        elif name == "speech":
            value = self.speech.evaluate(now, self.running_segments())
        else:
            value = self.heart.evaluate(now)
        self._cache[name] = (now, value)
        self._dirty.discard(name)
        return value

    def evaluate(self, now: float | None = None, triggered_by: EventType | None = None) -> None:
        now = self.clock.now() if now is None else now
        if self.heart.update_calibration(now):
            self._dirty.add("heart")
            self._last_heart_availability = None
        body = self._component("body", now)
        speech = self._component("speech", now)
        heart = self._component("heart", now)

        body_trigger = triggered_by in (EventType.pose_frame, None)  # pose frames or time ticks
        if self.state == "running" and body_trigger and (
                body["tracking_state"] != self._last_body_state
                or (triggered_by == EventType.pose_frame and now - self._last_body_emit >= 1 / self.config.pose.metrics_emit_hz)):
            self._last_body_state, self._last_body_emit = body["tracking_state"], now
            self._publish(EventType.body_metrics, _strip(body))
        if triggered_by in (EventType.speech_transcript_final, EventType.audio_playback) or (
                triggered_by in SPEECH_TYPES and now - self._last_speech_emit >= 1.0):
            self._last_speech_emit = now
            self._publish(EventType.speech_metrics, _strip(speech))
        if triggered_by == EventType.heart_rate_sample or heart["availability"] != self._last_heart_availability:
            self._last_heart_availability = heart["availability"]
            self._publish(EventType.heart_rate_state, _strip(heart))

        if self.state != "running":
            return
        evals = build_evals(now, body, speech, heart, self.config.speech, self.config.heart,
                            self.config.coaching, list(self.body.last_event_ids), self.config.pose)
        feedback = self.coach.evaluate(now, evals)
        if feedback:
            self.feedback_count[feedback["rule_id"]] = self.feedback_count.get(feedback["rule_id"], 0) + 1
            if self.on_feedback:
                self.on_feedback(self, feedback)  # may rephrase / speak asynchronously, then publish
            else:
                self.publish_feedback(feedback)

    def publish_feedback(self, feedback: dict) -> dict:
        return self._publish(EventType.coaching_feedback, feedback)

    def start_calibration(self, duration_s: float | None) -> dict:
        if self.state == "ended":
            raise SessionError("invalid_state", "session has ended", 409)
        cal = self.heart.start_calibration(self.clock.now(), duration_s)
        self._dirty.add("heart")
        self._last_heart_availability = None
        self.evaluate()
        return _strip(cal)

    def device_connection(self, device_id: str, kind: str, connected: bool, reason: str) -> None:
        dev = self.devices.setdefault(device_id, {"device_id": device_id, "kind": kind, "simulated": self.simulated,
                                                  "relay_device_id": None, "last_event_at_t": None, "events": 0,
                                                  "status": None})
        dev["connected"] = connected
        self._publish(EventType.device_status, {"status": "online" if connected else "offline",
                                                "subject_device_id": device_id, "reason": reason})

    def _warn(self, key: str, message: str, details: dict | None = None, code: str | None = None,
              every_s: float = 5.0) -> None:
        now = SystemClock().now()
        if now - self._last_warning.get(key, -1e9) < every_s:
            return
        self._last_warning[key] = now
        self._publish(EventType.system_warning, {"code": code or key, "message": message, "details": details})

    def _publish(self, etype: EventType, payload: dict) -> dict:
        model = SERVER_PAYLOAD_MODELS.get(etype) or PAYLOAD_MODELS.get(etype)
        if model is not None:
            payload = model.model_validate(payload).model_dump(mode="json")
        now = self.clock.now()
        self._server_seq += 1
        event = {
            "schema_version": SCHEMA_VERSION, "cursor": 0, "event_id": f"srv-{uuid.uuid4().hex[:16]}",
            "session_id": self.id,
            "source": {"device_id": SERVER_SOURCE_ID, "kind": "server", "simulated": self.simulated,
                       "relay_device_id": None},
            "sequence": self._server_seq, "event_type": etype.value, "captured_at": to_iso(now),
            "source_monotonic_ms": None, "received_at": to_iso(SystemClock().now()),
            "timing": {"clock_basis": "server", "clock_offset_ms": 0.0, "clock_uncertainty_ms": 0.0,
                       "corrected_captured_at": to_iso(now), "out_of_order": False, "late": False},
            "payload": payload,
        }
        self._append(event)
        return event

    def _append(self, event: dict) -> None:
        self.log.append(event)
        for sub in list(self.subscribers):
            sub.offer(event)

    # ======================================================================= views
    def snapshot(self) -> dict:
        now = self.clock.now()
        self._dirty.update({"body", "speech", "heart"})
        active = self.coach.active if (self.coach.active_until and now < self.coach.active_until) else None
        return {
            "schema_version": SCHEMA_VERSION,
            "session": self.public(),
            "cursor": self.log.head,
            "server_time": to_iso(SystemClock().now()),
            "session_time": to_iso(now),
            "devices": [_strip(d) for d in self.devices.values()],
            "clock": {dev_id: self.clock_info(dev_id) for dev_id in self.devices},
            "body": _strip(self._component("body", now)),
            "speech": _strip(self._component("speech", now)),
            "heart_rate": _strip(self._component("heart", now)),
            "coaching": {"active": active, "rules": _strip(self.coach.status())},
            "counters": dict(self.counters),
            "buffers": self.log.counts(),
            "ingest_queue": {"high": len(self._high), "pose": len(self._pose),
                             "pose_capacity": self.settings.ingest_pose_queue},
        }

    def clock_info(self, device_id: str) -> dict | None:
        info = self.registry.devices.get(device_id)
        estimate = info.clock.estimate(SystemClock().now()) if info else None
        if estimate is None:
            return None
        return {"offset_ms": round(estimate.offset_ms, 3), "uncertainty_ms": round(estimate.uncertainty_ms, 3),
                "samples": estimate.samples, "best_rtt_ms": round(estimate.best_rtt_ms, 3)}

    def summary(self) -> dict:
        now = self.ended_at or self.clock.now()
        running = self.running_intervals(now)
        speech = self.speech.evaluate(now, self.running_segments())
        heart = self.heart.evaluate(now)
        body = self.body
        heart_samples = [s for s in self.heart.samples]
        above = None
        if self.heart.reference_bpm is not None:
            above = sum(1 for s in heart_samples if s["fresh_on_arrival"]
                        and s["bpm"] - self.heart.reference_bpm >= self.config.heart.rise_threshold_bpm)
        sources = sorted({(d["device_id"], d["kind"], d["simulated"]) for d in self.devices.values()})
        return {
            "schema_version": SCHEMA_VERSION,
            "session_id": self.id,
            "final": self.state == "ended",
            "state": self.state,
            "simulated": self.simulated,
            "sources": [{"device_id": d, "kind": k, "simulated": s} for d, k, s in sources],
            "running_time_s": round(sum(e - s for s, e in running), 2),
            "speech": {
                "words": speech["final"]["words_total"],
                "rate_wpm_session": speech["final"]["rate_wpm_session"],
                "speaking_time_s": speech["activity"]["speaking_time_s"],
                "long_pauses": speech["activity"]["long_pauses_total"],
                "fillers": speech["final"]["fillers_total"],
                "utterances": speech["final"]["utterances"],
                "vad_method": speech["activity"]["vad_method"],
            },
            "body": {"pose_frames": body.frames, "frames_with_body": body.valid_frames,
                     "body_visible_ratio": round(body.valid_frames / body.frames, 3) if body.frames else None,
                     "mode": body.mode},
            "heart_rate": {
                "reference": _strip(heart["reference"]),
                "samples": len(heart_samples),
                "late_samples": self.heart.late_samples,
                "fresh_samples_at_or_above_threshold": above,
                "threshold_bpm": self.config.heart.rise_threshold_bpm,
                "note": "Observation relative to a session reference; not a stress or health assessment.",
            },
            "coaching": {"suggestions": len(self.coach.history), "by_rule": dict(self.feedback_count),
                         "items": [_strip({k: v for k, v in item.items() if k != "t"} | {"fired_at_t": item["t"]})
                                   for item in self.coach.history]},
            "data_quality": dict(self.counters),
        }


class SessionManager:
    def __init__(self, settings: Settings, registry: DeviceRegistry | None = None):
        self.settings = settings
        self.registry = registry or DeviceRegistry()
        self.sessions: dict[str, Session] = {}
        self.on_feedback: Callable[[Session, dict], None] | None = None

    def create(self, **kwargs) -> Session:
        self.cleanup()
        if len(self.sessions) >= self.settings.max_sessions:
            raise SessionError("too_many_sessions", "session limit reached; stop or wait for TTL cleanup", 429)
        try:
            session = Session(self.settings, self.registry, on_feedback=self.on_feedback, **kwargs)
        except (ValidationError, ValueError) as exc:
            raise SessionError("invalid_config", str(exc)[:500], 422) from exc
        self.sessions[session.id] = session
        return session

    def get(self, session_id: str) -> Session:
        session = self.sessions.get(session_id)
        if session is None:
            raise SessionError("session_not_found", f"unknown session {session_id}", 404)
        return session

    def latest_active(self) -> Session | None:
        active = [s for s in self.sessions.values() if s.state != "ended"]
        return max(active, key=lambda s: s.created_at) if active else None

    def cleanup(self, now: float | None = None) -> list[str]:
        """Remove sessions ended longer than the TTL ago, or idle (no events/transitions) that long.
        Uses the server wall clock, because event_time sessions may run ahead of real time."""
        now = SystemClock().now() if now is None else now
        ttl = self.settings.session_ttl_s
        removed = []
        for sid, session in list(self.sessions.items()):
            ended_long_ago = session.ended_wall is not None and now - session.ended_wall >= ttl
            idle = now - session.last_activity_wall >= ttl
            if ended_long_ago or idle:
                session.stop_worker()
                for sub in list(session.subscribers):
                    sub.close("session_expired")
                del self.sessions[sid]
                removed.append(sid)
        return removed

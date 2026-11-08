"""Explicit JSONL export and deterministic replay (development).

Export: one header line, then every retained event in cursor order. Buffers are bounded, so
an export of a long session contains only what is still retained (pose history is short).

Replay: device-originated events are fed into a fresh event_time session in their original
processing order, using the exported corrected capture times (no clock correction is applied
twice). Server-derived events (metrics, coaching) are recomputed, not copied, so a replay is a
regression check for the metrics and rules. Simulated flags are preserved.
"""

from __future__ import annotations

import gzip
import json
from datetime import datetime
from pathlib import Path
from typing import Iterator

from coach import SCHEMA_VERSION
from coach.assistant import session_playback
from coach.session import Session, SessionManager
from coach.timeutil import EventTimeClock, epoch, to_iso
from coach.wire import EventIn

SESSION_ACTIONS = {("created", "running"): "start", ("running", "paused"): "pause",
                   ("paused", "running"): "resume", ("created", "ended"): "stop",
                   ("running", "ended"): "stop", ("paused", "ended"): "stop"}


def export_lines(session: Session) -> Iterator[str]:
    header = {"type": "export.header", "schema_version": SCHEMA_VERSION, "exported_at": to_iso(datetime.now().astimezone()),
              "session": session.public(), "simulated": session.simulated,
              "buffers": session.log.counts(),
              "note": "Retained events only (bounded in-memory buffers). No raw audio or video."}
    yield json.dumps(header, ensure_ascii=False) + "\n"
    for event in session.log.all_events():
        yield json.dumps({"type": "event", "event": event}, ensure_ascii=False, allow_nan=False) + "\n"


def read_export(path: Path) -> tuple[dict, list[dict]]:
    header, events = None, []
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("type") == "export.header":
                header = record
            elif record.get("type") == "event":
                events.append(record["event"])
            else:
                raise ValueError(f"line {number}: unknown record type {record.get('type')!r}")
    if header is None:
        raise ValueError("missing export.header line")
    if header.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"schema_version {header.get('schema_version')} is not supported")
    return header, sorted(events, key=lambda e: e["cursor"])


def replay(manager: SessionManager, header: dict, events: list[dict]) -> Session:
    meta = header["session"]
    first = min((epoch(datetime.fromisoformat(e["timing"]["corrected_captured_at"].replace("Z", "+00:00")))
                 for e in events), default=0.0)
    session = manager.create(label=f"replay of {meta['session_id']}", mic_source=meta["mic_source"],
                             timeline="event_time", simulated=header["simulated"], config=meta["config"],
                             clock=EventTimeClock(first))
    calibrations = set()
    for event in events:
        t = epoch(datetime.fromisoformat(event["timing"]["corrected_captured_at"].replace("Z", "+00:00")))
        session.clock.observe(t)
        etype, payload = event["event_type"], event["payload"]
        if event["source"]["kind"] == "server":
            if etype == "session.state" and payload.get("previous"):
                action = SESSION_ACTIONS.get((payload["previous"], payload["state"]))
                if action and session.state == payload["previous"]:
                    session.transition(action, reason="replay")
            elif etype == "heart_rate.state":
                ref = payload.get("reference") or {}
                started = ref.get("started_at")
                if ref.get("status") == "collecting" and started and started not in calibrations:
                    calibrations.add(started)
                    ends = epoch(datetime.fromisoformat(ref["ends_at"].replace("Z", "+00:00")))
                    session.start_calibration(ends - epoch(datetime.fromisoformat(started.replace("Z", "+00:00"))))
            elif etype == "audio.playback":
                session_playback(session, payload["state"], {"feedback_id": payload.get("feedback_id"),
                                                             "language": payload.get("language"),
                                                             "display_text": payload.get("text")},
                                 payload["engine"], playback_id=payload["playback_id"], reason="replay")
            continue
        incoming = {k: event[k] for k in ("schema_version", "event_id", "session_id", "source", "sequence",
                                          "event_type", "source_monotonic_ms")}
        incoming["session_id"] = session.id
        incoming["captured_at"] = event["timing"]["corrected_captured_at"]
        # Payload timestamps were on the device clock too: apply the exported offset once.
        offset = (event["timing"].get("clock_offset_ms") or 0.0) / 1000.0
        payload = dict(payload)
        for key in ("measured_at", "audio_start_at"):
            if payload.get(key):
                payload[key] = to_iso(epoch(datetime.fromisoformat(payload[key].replace("Z", "+00:00"))) + offset)
        incoming["payload"] = payload
        session.accept(EventIn.model_validate(incoming), principal_device=None, connection_kind=None)
        session.process_pending()
    return session

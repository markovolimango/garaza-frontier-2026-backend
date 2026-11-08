import itertools
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from coach.config import Settings  # noqa: E402
from coach.session import SessionManager  # noqa: E402
from coach.timeutil import ManualClock, to_iso  # noqa: E402
from coach.wire import EventIn  # noqa: E402

T0 = 1_800_000_000.0
_ids = itertools.count()


@pytest.fixture
def settings(tmp_path):
    s = Settings()
    s.runtime_dir = tmp_path / "runtime"
    s.api_token = "test-operator-token-0123456789abcdef"
    s.assistant_enabled = False
    s.unauth_timeout_s = 0.5
    return s


@pytest.fixture
def manager(settings):
    return SessionManager(settings)


@pytest.fixture
def clock():
    return ManualClock(T0)


def make_session(manager, clock, *, running=True, mic="iphone", simulated=False, config=None, timeline="live"):
    session = manager.create(label="test", mic_source=mic, timeline=timeline, simulated=simulated,
                             config=config, clock=clock)
    if running:
        session.transition("start")
    return session


class Device:
    """Builds device events for tests (per-source sequences)."""

    def __init__(self, device_id="phone-1", kind="iphone", simulated=False):
        self.device_id, self.kind, self.simulated = device_id, kind, simulated
        self.seq = {}

    def ev(self, session, event_type, payload, t, *, source=None, seq=None, event_id=None):
        source = source or {"device_id": self.device_id, "kind": self.kind, "simulated": self.simulated}
        n = self.seq.get(source["device_id"], 0) if seq is None else seq
        self.seq[source["device_id"]] = max(self.seq.get(source["device_id"], 0), n + 1)
        return EventIn.model_validate({
            "schema_version": "1.0", "event_id": event_id or f"e{next(_ids)}", "session_id": session.id,
            "source": source, "sequence": n, "event_type": event_type, "captured_at": to_iso(t),
            "payload": payload})

    def send(self, session, event_type, payload, t, principal="phone-1", conn="iphone", **kw):
        result = session.accept(self.ev(session, event_type, payload, t, **kw), principal, conn)
        session.process_pending()
        return result


def pose2d(present=True, wrist_dx=0.0, scale=1.0, size=(1920, 1080), conf=0.9):
    if not present:
        return {"mode": "2d", "detector": "test", "image": {"width": size[0], "height": size[1]},
                "persons_detected": 0, "tracking_state": "no_person", "joints_2d": []}
    base = {"left_shoulder": (0.56, 0.33), "right_shoulder": (0.44, 0.33), "left_elbow": (0.60, 0.45),
            "right_elbow": (0.40, 0.45), "left_wrist": (0.60 + wrist_dx, 0.56), "right_wrist": (0.40, 0.56),
            "left_hip": (0.54, 0.58), "right_hip": (0.46, 0.58)}
    joints = [{"name": n, "x": 0.5 + (x - 0.5) * scale, "y": 0.5 + (y - 0.5) * scale, "confidence": conf}
              for n, (x, y) in base.items()]
    return {"mode": "2d", "detector": "test", "image": {"width": size[0], "height": size[1]},
            "persons_detected": 1, "tracking_state": "tracking", "joints_2d": joints}


def vad(transition):
    return {"transition": transition, "vad_method": "energy_threshold_heuristic_v1", "calibrated": True}


def transcript(uid, revision, text, start=None, segments=None):
    return {"utterance_id": uid, "revision": revision, "text": text, "language": "en-US", "on_device": True,
            "audio_start_at": to_iso(start) if start is not None else None, "segments": segments}


def hr(bpm, measured, mode="workout_session", delivery="live_message"):
    return {"bpm": bpm, "measured_at": to_iso(measured), "collection_mode": mode, "delivery": delivery}

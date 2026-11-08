"""WebSocket message shapes (documentation + generated schemas/TypeScript).

/v1/ingest (devices) and /v1/stream (frontends). Tokens travel in the Authorization header or
in an `auth` first message, never in the URL.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from coach.wire import EventIn, EventOut, Strict


# ------------------------------------------------------------------ shared
class AuthMessage(Strict):
    type: Literal["auth"]
    token: str | None = Field(None, description="Device token (ingest) or operator token (stream).")
    ticket: str | None = Field(None, description="Short-lived single-use stream ticket (browser clients).")


class ErrorMessage(Strict):
    type: Literal["error"]
    error: dict[str, Any] = Field(description="{code, message, details?}")


class PingMessage(Strict):
    type: Literal["ping"]


# ------------------------------------------------------------------ ingest: client -> server
class ClockPing(Strict):
    type: Literal["clock.ping"]
    t0: float = Field(description="Device wall clock, epoch ms, when sent.")


class ClockSampleMessage(Strict):
    type: Literal["clock.sample"]
    t0: float
    t1: float = Field(description="Server receive time from clock.pong, epoch ms.")
    t2: float = Field(description="Server send time from clock.pong, epoch ms.")
    t3: float = Field(description="Device wall clock when clock.pong arrived, epoch ms.")


class JoinMessage(Strict):
    type: Literal["join"]
    session_id: str | None = Field(None, description="null = most recent session that has not ended.")


class EventMessage(Strict):
    type: Literal["event"]
    event: EventIn


class EventsMessage(Strict):
    type: Literal["events"]
    events: list[EventIn] = Field(min_length=1, max_length=100)


# ------------------------------------------------------------------ ingest: server -> client
class IngestAuthOk(Strict):
    type: Literal["auth.ok"]
    device_id: str
    kind: str
    schema_version: str
    server_time_ms: float
    limits: dict[str, Any]


class ClockPong(Strict):
    type: Literal["clock.pong"]
    t0: float | None
    t1: float
    t2: float


class ClockEstimateMessage(Strict):
    type: Literal["clock.estimate"]
    offset_ms: float = Field(description="server_time - device_time")
    uncertainty_ms: float
    rtt_ms: float
    samples: int


class SessionControl(Strict):
    type: Literal["session"]
    session: dict[str, Any] = Field(description="{session_id, state, mic_source, simulated, timeline, language, pose_rate_hz}")


class AckResult(Strict):
    event_id: str | None
    status: Literal["accepted", "duplicate", "rejected"]
    code: str | None = None
    message: str | None = None
    details: dict[str, Any] | None = None
    retryable: bool | None = None


class AckMessage(Strict):
    type: Literal["ack"]
    results: list[AckResult]


class BackpressureMessage(Strict):
    type: Literal["backpressure"]
    state: Literal["on", "off"]
    lane: Literal["pose"]
    queue_level: float
    advice: str | None = None


class PongMessage(Strict):
    type: Literal["pong"]
    server_time_ms: float | None = None


# ------------------------------------------------------------------ stream
class SubscribeMessage(Strict):
    type: Literal["subscribe"]
    session_id: str = Field("latest", description="Session id or 'latest'.")
    event_types: list[str] | None = Field(None, description="Exact types or prefix wildcards such as 'speech.*'.")
    after_cursor: int | None = Field(None, description="Resume: replay retained events with cursor > after_cursor.")


class UnsubscribeMessage(Strict):
    type: Literal["unsubscribe"]


class StreamAuthOk(Strict):
    type: Literal["auth.ok"]
    role: Literal["operator", "ticket"]
    schema_version: str


class SnapshotMessage(Strict):
    type: Literal["snapshot"]
    cursor: int = Field(description="Snapshot reflects all events with cursor <= this value.")
    snapshot: dict[str, Any]


class StreamEventMessage(Strict):
    type: Literal["event"]
    event: EventOut
    replay: bool | None = Field(None, description="True for history replayed after a resume.")


class SyncedMessage(Strict):
    type: Literal["synced"]
    cursor: int = Field(description="History boundary: every later event is live.")
    replayed: int
    note: str | None = None


class HistoryExpiredMessage(Strict):
    type: Literal["history_expired"]
    requested_after_cursor: int
    oldest_complete_after_cursor: int
    head_cursor: int


class HeartbeatMessage(Strict):
    type: Literal["heartbeat"]
    cursor: int | None


class UnsubscribedMessage(Strict):
    type: Literal["unsubscribed"]


INGEST_CLIENT = [AuthMessage, ClockPing, ClockSampleMessage, JoinMessage, EventMessage, EventsMessage, PingMessage]
INGEST_SERVER = [IngestAuthOk, ClockPong, ClockEstimateMessage, SessionControl, AckMessage, BackpressureMessage,
                 PongMessage, ErrorMessage]
STREAM_CLIENT = [AuthMessage, SubscribeMessage, UnsubscribeMessage, PingMessage]
STREAM_SERVER = [StreamAuthOk, SnapshotMessage, StreamEventMessage, SyncedMessage, HistoryExpiredMessage,
                 HeartbeatMessage, UnsubscribedMessage, PongMessage, ErrorMessage]

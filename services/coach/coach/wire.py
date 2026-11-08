"""Versioned wire contract (schema_version 1.0).

Envelope fields are shared by every event. Payload models are selected by `event_type`.
Generated JSON Schemas live in contracts/schemas/ (python -m coach schemas).

Conventions
- Times: UTC ISO 8601 strings. `captured_at` is the *source device's* clock at capture;
  `received_at` is assigned by the server; `timing.corrected_captured_at` maps capture time
  into the server clock using the device's clock-offset estimate (with uncertainty).
- Missing values are `null`, never 0. Confidence appears only where the producing API provides it.
- Units are part of field names (`_ms`, `_s`, `_m`, `_bpm`, `_deg`, `_wpm`) or given in `unit` fields.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from coach import SCHEMA_VERSION

ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$"


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ------------------------------------------------------------------------------- envelope
class SourceKind(str, Enum):
    iphone = "iphone"
    watch = "watch"
    mac = "mac"
    simulator = "simulator"
    server = "server"
    assistant = "assistant"


class Source(Strict):
    device_id: str = Field(pattern=ID_PATTERN, description="Stable per-install device identifier.")
    kind: SourceKind
    simulated: bool = Field(False, description="True for synthetic data. Real and simulated data are never mixed silently.")
    relay_device_id: str | None = Field(None, pattern=ID_PATTERN,
                                        description="Device that forwarded this event (e.g. the iPhone relaying Watch samples).")


class EventType(str, Enum):
    session_state = "session.state"
    device_status = "device.status"
    pose_frame = "pose.frame"
    body_metrics = "body.metrics"
    speech_activity = "speech.activity"
    speech_transcript_partial = "speech.transcript.partial"
    speech_transcript_final = "speech.transcript.final"
    speech_metrics = "speech.metrics"
    heart_rate_sample = "heart_rate.sample"
    heart_rate_state = "heart_rate.state"
    coaching_feedback = "coaching.feedback"
    behavior_episode = "behavior.episode"
    audio_playback = "audio.playback"
    system_warning = "system.warning"


DEVICE_EVENT_TYPES = {
    EventType.device_status, EventType.pose_frame, EventType.speech_activity,
    EventType.speech_transcript_partial, EventType.speech_transcript_final,
    EventType.heart_rate_sample, EventType.audio_playback, EventType.system_warning,
}
SERVER_EVENT_TYPES = {
    EventType.session_state, EventType.device_status, EventType.body_metrics, EventType.speech_metrics,
    EventType.heart_rate_state, EventType.coaching_feedback, EventType.behavior_episode, EventType.audio_playback,
    EventType.system_warning,
}
# Ingest priority: control and heart-rate before speech before high-rate pose frames.
PRIORITY_HIGH = {EventType.device_status, EventType.heart_rate_sample, EventType.audio_playback,
                 EventType.system_warning, EventType.speech_activity,
                 EventType.speech_transcript_final, EventType.speech_transcript_partial}


class EventIn(Strict):
    """An event as sent by a device to /v1/ingest."""

    schema_version: Literal["1.0"] = SCHEMA_VERSION
    event_id: str = Field(pattern=ID_PATTERN, description="Unique per source; used for de-duplication (resends are safe).")
    session_id: str = Field(pattern=ID_PATTERN)
    source: Source
    sequence: int = Field(ge=0, description="Per-source counter, assigned at first transmission; gaps = lost events.")
    event_type: EventType
    captured_at: AwareDatetime = Field(description="Capture time on the source device clock (UTC).")
    source_monotonic_ms: float | None = Field(None, ge=0, description="Source monotonic clock (ms) if available.")
    received_at: None = Field(None, description="Must be null on ingest; assigned by the server.")
    payload: dict[str, Any]


class Timing(Strict):
    clock_basis: Literal["handshake", "relay_assumed", "server", "none"] = Field(
        description="handshake: device offset measured; relay_assumed: relayed device clock assumed in sync with "
                    "its relay; server: produced by the server; none: no offset estimate (uncorrected).")
    clock_offset_ms: float | None = Field(None, description="Estimated server_time - device_time.")
    clock_uncertainty_ms: float | None = Field(None, description="Half round-trip of the best handshake sample, plus margin.")
    corrected_captured_at: AwareDatetime = Field(description="captured_at mapped to the server clock (event time).")
    out_of_order: bool = Field(False, description="Arrived after a later sequence number from the same source.")
    late: bool = Field(False, description="Older than the staleness limit for its type when it arrived.")


class EventOut(Strict):
    """An event as delivered on /v1/stream and REST event pages."""

    schema_version: Literal["1.0"] = SCHEMA_VERSION
    cursor: int = Field(ge=1, description="Server-assigned, strictly increasing per session.")
    event_id: str
    session_id: str
    source: Source
    sequence: int
    event_type: EventType
    captured_at: AwareDatetime
    source_monotonic_ms: float | None = None
    received_at: AwareDatetime
    timing: Timing
    payload: dict[str, Any]


# ------------------------------------------------------------------------------- payloads
class Point2D(Strict):
    """Normalized image point (top-left origin). Projections of joints outside the frame fall
    outside 0..1 (observed up to ~3 on cropped photos); clients must clip before drawing."""
    x: float = Field(ge=-10, le=10)
    y: float = Field(ge=-10, le=10)


class Joint2D(Strict):
    name: str = Field(description="Vision joint name in snake_case, anatomical left/right (e.g. left_wrist).")
    x: float = Field(ge=-0.05, le=1.05, description="Normalized image x, 0 = left edge (top-left origin).")
    y: float = Field(ge=-0.05, le=1.05, description="Normalized image y, 0 = top edge (Vision's lower-left origin converted).")
    confidence: float = Field(ge=0, le=1, description="VNRecognizedPoint.confidence (Apple Vision) or the YOLO keypoint "
                                                      "confidence (vision/, detector ultralytics-*).")


class Joint3D(Strict):
    name: str = Field(description="Vision 3D joint name in snake_case, anatomical left/right.")
    position_m: list[float] = Field(min_length=3, max_length=3, description="Model position relative to root (hip center), meters.")
    local_position_m: list[float] | None = Field(None, min_length=3, max_length=3, description="Position relative to the parent joint, meters.")
    parent: str | None = Field(None, description="Parent joint name (Vision parentJointName).")
    image_point: Point2D | None = Field(None, description="Projection into the image, normalized, top-left origin.")


class ImageInfo(Strict):
    width: int = Field(gt=0, description="Pixel width of the image Vision analysed (after orientation).")
    height: int = Field(gt=0)
    orientation: Literal["up", "down", "left", "right", "up_mirrored", "down_mirrored", "left_mirrored", "right_mirrored"] = "up"
    mirrored: bool = Field(False, description="True if the analysed image was mirrored (front-camera style).")
    camera_position: Literal["back", "front", "external", "unspecified"] = "unspecified"


class PoseFramePayload(Strict):
    mode: Literal["3d", "2d"] = Field(description="Active Vision mode. 3D and 2D outputs are not interchangeable.")
    detector: str = Field(max_length=64, description="e.g. VNDetectHumanBodyPose3DRequest, VNDetectHumanBodyPoseRequest, simulated")
    detector_revision: int | None = None
    image: ImageInfo
    persons_detected: int = Field(ge=0, le=16)
    tracking_state: Literal["tracking", "no_person", "interrupted"] = Field(
        description="Device view of this frame: person found, no person, or capture interrupted.")
    inference_ms: float | None = Field(None, ge=0, description="Vision request duration measured on the device.")
    dropped_frames_since_last: int = Field(0, ge=0, description="Camera frames skipped on device (one in-flight request).")
    coordinate_space_2d: Literal["image_normalized_top_left"] = "image_normalized_top_left"
    coordinate_space_3d: Literal["vision_body_root_m"] | None = None
    joints_2d: list[Joint2D] | None = Field(None, max_length=32)
    joints_3d: list[Joint3D] | None = Field(None, max_length=32)
    body_height_m: float | None = Field(None, gt=0, description="Vision bodyHeight; 1.8 m reference unless measured.")
    height_estimation: Literal["reference", "measured"] | None = None
    camera_origin_matrix: list[float] | None = Field(None, min_length=16, max_length=16,
                                                     description="Root(hip)->camera transform, column-major 4x4.")
    observation_confidence: float | None = Field(None, ge=0, le=1,
                                                 description="VNObservation.confidence passthrough; semantics not documented for 3D.")
    root_camera_position_m: list[float] | None = Field(None, min_length=3, max_length=3,
                                                       description="Root joint relative to the camera (Vision cameraRelativePosition), meters.")


class DeviceStatusPayload(Strict):
    status: Literal["online", "offline", "heartbeat", "interrupted", "resumed"]
    subject_device_id: str | None = Field(None, pattern=ID_PATTERN,
                                          description="Device described, if not the source (server-reported status).")
    app_version: str | None = Field(None, max_length=32)
    os_version: str | None = Field(None, max_length=32)
    model: str | None = Field(None, max_length=64)
    pose_mode: Literal["3d", "2d", "off"] | None = None
    pose_rate_hz: float | None = Field(None, ge=0, le=60)
    speech: dict[str, Any] | None = Field(None, description="Speech availability (authorized, on_device, locale, reason).")
    watch: dict[str, Any] | None = Field(None, description="Watch link (paired, reachable, authorized, collection_mode).")
    thermal_state: Literal["nominal", "fair", "serious", "critical"] | None = None
    reason: str | None = Field(None, max_length=200)


class SpeechActivityPayload(Strict):
    transition: Literal["speech_start", "speech_end"] = Field(description="VAD transition at captured_at (audio time).")
    vad_method: str = Field(max_length=64, description="e.g. energy_threshold_heuristic_v1 (labelled heuristic).")
    level_dbfs: float | None = Field(None, le=0)
    threshold_dbfs: float | None = Field(None, le=0)
    noise_floor_dbfs: float | None = Field(None, le=0)
    calibrated: bool = Field(False, description="True once the noise floor was measured for this session.")


class TranscriptSegment(Strict):
    text: str = Field(max_length=200)
    start_s: float = Field(ge=0, description="Offset from audio_start_at, seconds.")
    duration_s: float = Field(ge=0)
    confidence: float | None = Field(None, ge=0, le=1, description="Present only when the recognizer provides it.")


class TranscriptPayload(Strict):
    utterance_id: str = Field(pattern=ID_PATTERN, description="Recognition task/utterance identity.")
    revision: int = Field(ge=0, description="Increases with every update of the same utterance.")
    text: str = Field(max_length=4000)
    language: str = Field(max_length=16)
    on_device: bool = Field(description="True only if recognition was required to run on device.")
    audio_start_at: AwareDatetime | None = Field(None, description="Wall time of the utterance's first audio sample.")
    segments: list[TranscriptSegment] | None = Field(None, max_length=1000)
    recognizer: str = Field("SFSpeechRecognizer", max_length=64)


class HeartRateSamplePayload(Strict):
    bpm: float = Field(gt=20, lt=260)
    measured_at: AwareDatetime = Field(description="HealthKit sample end date on the Watch clock.")
    sample_age_ms_at_send: float | None = Field(None, ge=0, description="Age when the relaying device sent it.")
    collection_mode: Literal["passive_healthkit", "workout_session", "simulated"]
    delivery: Literal["live_message", "queued_transfer", "application_context", "direct"] = Field(
        description="WatchConnectivity path; queued and context deliveries can be minutes old.")
    availability: Literal["available", "unauthorized", "unavailable", "watch_unreachable"] = "available"
    hk_sample_uuid: str | None = Field(None, max_length=64)
    hrv_sdnn_ms: float | None = Field(None, gt=0, description="Optional contextual HealthKit SDNN; never computed from bpm.")


class AudioPlaybackPayload(Strict):
    state: Literal["scheduled", "started", "finished", "interrupted", "skipped"]
    playback_id: str = Field(pattern=ID_PATTERN)
    feedback_id: str | None = None
    engine: Literal["avspeechsynthesizer", "audio_clip", "text_only", "simulated"]
    voice: str | None = Field(None, max_length=128)
    language: str | None = Field(None, max_length=16)
    text: str | None = Field(None, max_length=500)
    reason: str | None = Field(None, max_length=200)


class SystemWarningPayload(Strict):
    code: str = Field(max_length=64)
    message: str = Field(max_length=500)
    details: dict[str, Any] | None = None


PAYLOAD_MODELS: dict[EventType, type[Strict]] = {
    EventType.pose_frame: PoseFramePayload,
    EventType.device_status: DeviceStatusPayload,
    EventType.speech_activity: SpeechActivityPayload,
    EventType.speech_transcript_partial: TranscriptPayload,
    EventType.speech_transcript_final: TranscriptPayload,
    EventType.heart_rate_sample: HeartRateSamplePayload,
    EventType.audio_playback: AudioPlaybackPayload,
    EventType.system_warning: SystemWarningPayload,
}


# ------------------------------------------------------------------- server-produced payloads
Quality = Literal["good", "limited", "degraded", "insufficient_data", "stale", "unavailable"]


class SessionStatePayload(Strict):
    state: Literal["created", "running", "paused", "ended"]
    previous: Literal["created", "running", "paused", "ended"] | None = None
    reason: str | None = None


class BodyMetricsPayload(Strict):
    body_present: bool
    tracking_state: Literal["tracking", "partial", "lost", "stale", "unknown"]
    quality: Quality
    mode: Literal["3d", "2d"] | None = None
    window_s: float
    reference: dict[str, Any] | None = Field(None, description="Body reference used for normalisation (torso length).")
    wrist_movement: dict[str, Any] = Field(description="Mean wrist speed relative to the torso, per side; unit field included.")
    torso_displacement: dict[str, Any] = Field(description="Net torso-center displacement over the window, normalised.")
    torso_movement: dict[str, Any] = Field(default_factory=dict,
                                           description="Mean torso-center speed along its path over the window "
                                                       "(walking back and forth does not cancel out), torso lengths per second.")
    joint_angles_deg: dict[str, Any] = Field(description="Angles only where all three joints are valid; plane given.")
    posture: dict[str, Any] = Field(
        default_factory=dict,
        description="Posture measures, medians over `window_s` (null = unavailable), in torso lengths unless "
                    "noted: arms_cross (both wrists past the body midline; > 0 = crossed), arms_in_zone, "
                    "wrist_cross/wrist_height per side (height 0 = shoulder line, 1 = hip line), face_touch_distance "
                    "(nearest wrist to a face point), head_pitch (nose below the ear line, or below the shoulder line "
                    "without ears; head_pitch_source), head_pitch_reference (head-up percentile over a longer window) "
                    "and head_pitch_delta; head_roll (degrees: eye or ear line against the shoulder line), "
                    "head_roll_reference (the person's usual roll, median over a longer window) and head_roll_delta; "
                    "per side hand_in_pocket, hand_pocket_distance (wrist to its own hip, shoulder widths) and "
                    "elbow_angle (degrees); hands_in_pockets_count (hands likely in a pocket) and hands_in_pockets. "
                    "arms_crossed/face_touch/looking_down = measure past its rule threshold; head_tilt = head_roll_delta "
                    "past pose.head_tilt_min_deg (head_tilt and hands_in_pockets have no coaching rule: episodes only).")
    frames_in_window: int
    smoothing: dict[str, Any]
    note: str = "Movement observations only; they do not indicate emotional state."


class SpeechMetricsPayload(Strict):
    language: str
    final: dict[str, Any] = Field(description="From finalized transcripts only (authoritative).")
    provisional: dict[str, Any] = Field(description="Including partial results; may change, never used by rules.")
    activity: dict[str, Any] = Field(description="Speech/silence from VAD, pauses, suppression.")
    quality: Quality


class HeartRateStatePayload(Strict):
    availability: Literal["available", "stale", "no_data", "unauthorized", "unavailable", "watch_unreachable"]
    latest: dict[str, Any] | None
    reference: dict[str, Any] = Field(description="Session reference from an explicit quiet calibration (not clinical resting HR).")
    delta_from_reference_bpm: float | None
    above_reference: bool | None
    hrv: dict[str, Any] = Field(default_factory=lambda: {"status": "unavailable"})


class CoachingFeedbackPayload(Strict):
    feedback_id: str
    rule_id: str
    evidence_event_ids: list[str] = Field(max_length=50)
    observation: str
    suggested_action: str
    priority: int
    quality_state: Quality
    cooldown: dict[str, Any]
    language: str
    display_text: str = Field(description="Text to show or speak. observation/suggested_action stay deterministic.")
    text_source: Literal["template", "foundation_models"] = Field(
        description="Origin of display_text only; Foundation Models may rephrase, never change measurements.")
    expires_at: AwareDatetime


class BehaviorEpisodePayload(Strict):
    """One behaviour occurrence (coach/metrics/episodes.py): published once when it starts and once when
    it ends. Every occurrence, several at once; not throttled like coaching.feedback."""
    episode_id: str = Field(description="Same id on the start and the end event.")
    behavior: Literal["arms_crossed", "face_touch", "looking_down", "sway", "fast_hands", "head_tilt", "hands_in_pockets"]
    phase: Literal["start", "end"]
    started_at: AwareDatetime = Field(description="When the condition began to hold (before min_on_s confirmed it).")
    ended_at: AwareDatetime | None = Field(None, description="End events: when the condition was last seen.")
    duration_s: float | None = Field(None, ge=0, description="End events: ended_at - started_at.")
    end_reason: Literal["cleared", "tracking_lost", "session_paused", "session_ended"] | None = None
    measure: dict[str, Any] = Field(description="The measured value: name, unit, peak and the enter/exit thresholds.")
    mode: Literal["3d", "2d"] | None = None
    evidence_event_ids: list[str] = Field(default_factory=list, max_length=50)
    note: str = "An observed body position or movement, not an interpretation."


SERVER_PAYLOAD_MODELS: dict[EventType, type[Strict]] = {
    EventType.session_state: SessionStatePayload,
    EventType.body_metrics: BodyMetricsPayload,
    EventType.speech_metrics: SpeechMetricsPayload,
    EventType.heart_rate_state: HeartRateStatePayload,
    EventType.coaching_feedback: CoachingFeedbackPayload,
    EventType.behavior_episode: BehaviorEpisodePayload,
}


# --------------------------------------------------------------------------- REST models
class ErrorBody(Strict):
    code: str
    message: str
    details: dict[str, Any] | None = None


class ErrorEnvelope(Strict):
    error: ErrorBody


class SessionCreate(Strict):
    label: str | None = Field(None, max_length=120)
    mic_source: Literal["iphone", "mac", "none"] = Field("iphone", description="Exactly one authoritative microphone.")
    timeline: Literal["live", "event_time"] = Field(
        "live", description="live: server clock drives rules. event_time: corrected event times drive rules "
                            "(deterministic simulation/replay, may run faster than real time).")
    simulated: bool = Field(False, description="Session intended for synthetic data.")
    config: dict[str, Any] | None = Field(None, description="Overrides for SessionConfig (see GET /v1/capabilities).")


class CalibrationRequest(Strict):
    duration_s: float | None = Field(None, gt=0, le=600)


class PairRequest(Strict):
    code: str = Field(min_length=6, max_length=12)
    device_id: str = Field(pattern=ID_PATTERN)
    kind: Literal["iphone", "mac", "simulator"]
    name: str | None = Field(None, max_length=64)

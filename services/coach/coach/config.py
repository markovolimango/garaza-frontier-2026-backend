"""Server settings (environment / .env) and per-session tunables.

Every threshold below is a demo heuristic chosen for a first prototype, not a validated norm.
Override them per session (POST /v1/sessions {"config": {...}}) or via environment defaults. The
brain bridge and `python -m coach tune` pass services/coach/tuning.json as that config (tuning.py).
"""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator

SERVICE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_RUNTIME_DIR = SERVICE_DIR / ".runtime"


def _load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def _bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    lan: bool = False
    allow_insecure_lan: bool = False          # development only, explicit opt-in
    tls_cert: str | None = None
    tls_key: str | None = None
    api_token: str | None = None              # if unset, an ephemeral token is generated per run
    runtime_dir: Path = DEFAULT_RUNTIME_DIR
    allowed_origins: list[str] = field(default_factory=list)   # browser origins (CORS + WS Origin)
    max_sessions: int = 20
    session_ttl_s: float = 2 * 3600           # removed this long after ending (or idle)
    event_buffer: int = 20_000                # non-pose events kept per session (ring buffer)
    pose_buffer: int = 600                    # pose frames kept per session (~40-60 s at 10-15 Hz)
    ingest_high_queue: int = 2_000            # control / speech / heart-rate lane
    ingest_pose_queue: int = 64               # pose lane; oldest frames dropped first
    subscriber_queue: int = 2_000
    max_message_bytes: int = 256 * 1024
    unauth_timeout_s: float = 5.0
    pairing_code_ttl_s: float = 300.0
    device_token_ttl_s: float = 24 * 3600
    stream_ticket_ttl_s: float = 30.0
    assistant_url: str = "http://127.0.0.1:8766"
    assistant_token_file: Path = DEFAULT_RUNTIME_DIR / "assistant_token"
    assistant_enabled: bool = True
    assistant_timeout_s: float = 2.5

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "Settings":
        merged = {**_load_dotenv(SERVICE_DIR / ".env"), **(env if env is not None else os.environ)}
        get = merged.get
        settings = cls()
        settings.host = get("COACH_HOST", settings.host)
        settings.port = int(get("COACH_PORT", settings.port))
        settings.lan = _bool(get("COACH_LAN"), False)
        settings.allow_insecure_lan = _bool(get("COACH_ALLOW_INSECURE_LAN"), False)
        settings.tls_cert = get("COACH_TLS_CERT") or None
        settings.tls_key = get("COACH_TLS_KEY") or None
        settings.api_token = get("COACH_API_TOKEN") or None
        settings.runtime_dir = Path(get("COACH_RUNTIME_DIR") or DEFAULT_RUNTIME_DIR)
        origins = get("COACH_ALLOWED_ORIGINS", "")
        settings.allowed_origins = [o.strip() for o in origins.split(",") if o.strip()]
        settings.max_sessions = int(get("COACH_MAX_SESSIONS", settings.max_sessions))
        settings.session_ttl_s = float(get("COACH_SESSION_TTL_S", settings.session_ttl_s))
        settings.event_buffer = int(get("COACH_EVENT_BUFFER", settings.event_buffer))
        settings.pose_buffer = int(get("COACH_POSE_BUFFER", settings.pose_buffer))
        settings.max_message_bytes = int(get("COACH_MAX_MESSAGE_BYTES", settings.max_message_bytes))
        settings.assistant_url = get("COACH_ASSISTANT_URL", settings.assistant_url)
        settings.assistant_token_file = Path(get("COACH_ASSISTANT_TOKEN_FILE") or settings.runtime_dir / "assistant_token")
        settings.assistant_enabled = _bool(get("COACH_ASSISTANT_ENABLED"), True)
        return settings

    def validate_network(self) -> list[str]:
        """Return warnings; raise ValueError for unsafe combinations."""
        warnings = []
        loopback = self.host in {"localhost"} or _is_loopback(self.host)
        if not loopback and not self.lan:
            raise ValueError(f"Binding to {self.host} exposes the service; set COACH_LAN=1 (or --lan) explicitly.")
        has_tls = bool(self.tls_cert and self.tls_key)
        if self.lan and not has_tls and not self.allow_insecure_lan:
            raise ValueError("LAN mode needs TLS (COACH_TLS_CERT/COACH_TLS_KEY, see scripts/make-dev-cert.sh) "
                             "or the explicit development flag --allow-insecure-lan.")
        if self.lan and not has_tls:
            warnings.append("INSECURE LAN MODE (development only): traffic and tokens are not encrypted.")
        if "*" in self.allowed_origins:
            raise ValueError("Wildcard origins are not allowed; list explicit origins.")
        return warnings


def _is_loopback(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


# ----------------------------------------------------------------------------- session config
class _Cfg(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PoseConfig(_Cfg):
    target_rate_hz: float = Field(12.0, ge=1, le=30, description="Advisory pose observation rate for devices.")
    stale_after_s: float = Field(1.5, gt=0, description="A pose frame older than this is not 'current'.")
    tracking_lost_after_s: float = Field(1.0, gt=0, description="No valid body for this long -> tracking lost.")
    min_confidence_2d: float = Field(0.3, ge=0, le=1, description="2D joints below this Vision confidence are ignored.")
    smoothing_min_cutoff_hz: float = Field(1.5, gt=0, description="One-Euro filter minimum cutoff.")
    smoothing_beta: float = Field(0.4, ge=0, description="One-Euro filter speed coefficient.")
    reset_after_gap_s: float = Field(0.5, gt=0, description="Smoothing restarts after a gap this long.")
    metrics_window_s: float = Field(3.0, gt=0, description="Window for movement observations.")
    reference_window_s: float = Field(5.0, gt=0, description="Window for the median torso-length reference.")
    metrics_emit_hz: float = Field(2.0, gt=0, le=15, description="Max body.metrics events per second.")
    reorder_tolerance_s: float = Field(0.3, ge=0, description="Older frames than this are stored but not smoothed.")
    hand_movement_high_per_s: float = Field(
        1.5, gt=0, description="Rule body.hand_movement_high: faster wrist (torso lengths/s, relative to the torso) is 'high'.")
    hand_movement_clear_per_s: float = Field(
        1.0, gt=0, description="Hysteresis: the faster wrist must drop below this to re-arm the rule.")
    torso_movement_high_per_s: float = Field(
        0.4, gt=0, description="Rule body.torso_movement_high: torso-center speed (torso lengths/s) above this is 'high'.")
    torso_movement_clear_per_s: float = Field(
        0.25, gt=0, description="Hysteresis: torso-center speed must drop below this to re-arm the rule.")
    # Postures (2D keypoints; see metrics/body.py for the geometry). Distances in torso lengths.
    posture_window_s: float = Field(
        1.0, gt=0, description="Posture measures are medians over this window (one noisy frame does not count; "
                               "adds about half of it as delay).")
    arms_crossed_min_cross: float = Field(
        0.10, description="Rule body.arms_crossed: both wrists at least this far past the body midline, towards the "
                          "other side (torso lengths).")
    arms_crossed_clear_cross: float = Field(
        0.0, description="Hysteresis: re-arms once a wrist is back to the midline (score below this).")
    arms_crossed_min_height: float = Field(
        0.0, description="Crossed wrists must be at least this low on the torso (0 = shoulder line, 1 = hip line).")
    arms_crossed_max_height: float = Field(
        0.8, description="... and at most this low (hands crossed in front of the hips do not count).")
    arms_crossed_max_reach: float = Field(
        0.8, gt=0, description="Wrists further than this from the body midline (torso lengths) are not folded arms.")
    face_touch_max_distance: float = Field(
        0.35, gt=0, description="Rule body.face_touch: nearest wrist within this distance of a face point "
                                "(nose, eyes, ears), in torso lengths. 2D: a hand in front of the face counts too.")
    face_touch_clear_distance: float = Field(
        0.5, gt=0, description="Hysteresis: the nearest wrist must move further than this from the face to re-arm.")
    looking_down_min_delta: float = Field(
        0.06, description="Rule body.looking_down: head pitch (nose below the ear line, torso lengths) at least this "
                          "much above the head-up reference (~0.06 = about 20 degrees of head tilt).")
    looking_down_clear_delta: float = Field(
        0.03, description="Hysteresis: head pitch must come back within this of the reference to re-arm.")
    head_pitch_reference_window_s: float = Field(
        60.0, gt=0, description="Window for the head-up reference (adapts to camera height and the person).")
    head_pitch_reference_percentile: float = Field(
        20.0, ge=0, le=100, description="Head-up reference = this percentile of head pitch over the window "
                                        "(low = most 'up'; works while the head is up at least this % of the time).")
    head_pitch_reference_min_s: float = Field(
        5.0, ge=0, description="The reference needs this much history (s) before the rule can evaluate.")

    @model_validator(mode="after")
    def _hysteresis_order(self) -> "PoseConfig":
        pairs = (("hand_movement_clear_per_s", "hand_movement_high_per_s"),
                 ("torso_movement_clear_per_s", "torso_movement_high_per_s"),
                 ("arms_crossed_clear_cross", "arms_crossed_min_cross"),
                 ("looking_down_clear_delta", "looking_down_min_delta"),
                 ("face_touch_max_distance", "face_touch_clear_distance"),
                 ("arms_crossed_min_height", "arms_crossed_max_height"))
        for low, high in pairs:
            if getattr(self, low) >= getattr(self, high):
                raise ValueError(f"pose.{low} must be below pose.{high}")
        return self


class SpeechConfig(_Cfg):
    language: str = Field("en-US", description="BCP-47 language requested for transcription.")
    target_wpm_max: float = Field(165.0, gt=0, description="Practice target: speaking rate above this is 'fast'.")
    rate_clear_margin_wpm: float = Field(12.0, ge=0, description="Hysteresis: rate must fall this far below target.")
    wpm_window_s: float = Field(20.0, gt=0, description="Window for words-per-minute.")
    min_words_for_rate: int = Field(12, ge=1, description="Fewer final words in the window -> rate unavailable.")
    min_speaking_s_for_rate: float = Field(5.0, gt=0, description="Less speech-active time -> rate unavailable.")
    long_pause_s: float = Field(2.0, gt=0, description="Silence between speech segments counted as a long pause.")
    filler_window_s: float = Field(60.0, gt=0)
    filler_lexicon: list[str] | None = Field(None, description="Override the per-language filler list.")
    playback_tail_s: float = Field(0.6, ge=0, description="Speech analysis stays suppressed this long after playback.")
    stale_after_s: float = Field(15.0, gt=0, description="Speech events older than this do not update current state.")


class HeartConfig(_Cfg):
    fresh_max_age_s: float = Field(20.0, gt=0, description="Samples older than this are not 'fresh'.")
    calibration_s: float = Field(60.0, gt=0, description="Default quiet calibration duration for the session reference.")
    min_reference_samples: int = Field(5, ge=1, description="Fresh samples needed for a session reference.")
    rise_threshold_bpm: float = Field(15.0, gt=0, description="Above-reference threshold for the observation rule.")
    clear_margin_bpm: float = Field(5.0, ge=0, description="Hysteresis for clearing the above-reference state.")
    evaluation_window_s: float = Field(30.0, gt=0)
    min_fresh_samples: int = Field(3, ge=1, description="Fresh samples in the window required to evaluate.")


class RuleConfig(_Cfg):
    enabled: bool = True
    priority: int = Field(3, ge=1, le=9, description="1 = most important.")
    sustain_s: float = Field(8.0, ge=0, description="Condition must hold this long before firing.")
    cooldown_s: float = Field(45.0, ge=0, description="Minimum time before the same rule may fire again.")
    count: int = Field(3, ge=1, description="Occurrences needed (count-based rules).")
    window_s: float = Field(60.0, gt=0, description="Window for count-based rules.")


def _default_rules() -> dict[str, RuleConfig]:
    return {
        "body.tracking_lost": RuleConfig(priority=1, sustain_s=3.0, cooldown_s=20.0),
        "body.hand_movement_high": RuleConfig(priority=3, sustain_s=10.0, cooldown_s=60.0),
        "body.torso_movement_high": RuleConfig(priority=3, sustain_s=10.0, cooldown_s=60.0),
        # postures: short sustains (the posture window adds ~0.5 s)
        "body.arms_crossed": RuleConfig(priority=3, sustain_s=3.0, cooldown_s=45.0),
        "body.face_touch": RuleConfig(priority=3, sustain_s=1.0, cooldown_s=30.0),
        "body.looking_down": RuleConfig(priority=3, sustain_s=3.0, cooldown_s=30.0),
        "speech.rate_high": RuleConfig(priority=2, sustain_s=8.0, cooldown_s=45.0),
        "speech.long_pauses": RuleConfig(priority=3, sustain_s=0.0, cooldown_s=60.0, count=3, window_s=60.0),
        "speech.fillers": RuleConfig(priority=3, sustain_s=0.0, cooldown_s=60.0, count=4, window_s=60.0),
        "heart.above_reference": RuleConfig(priority=4, sustain_s=30.0, cooldown_s=120.0),
    }


class CoachingConfig(_Cfg):
    global_min_interval_s: float = Field(8.0, ge=0, description="Minimum time between any two suggestions.")
    display_s: float = Field(6.0, gt=0, description="A suggestion counts as active this long (one at a time).")
    language: str = Field("en", description="Language of suggestion texts (templates: en, sr).")
    speak: bool = Field(False, description="Send suggestions to the Mac assistant for speech synthesis.")
    rephrase_with_assistant: bool = Field(False, description="Ask Foundation Models to rephrase (timeout -> template).")
    rules: dict[str, RuleConfig] = Field(default_factory=_default_rules)


class SessionConfig(_Cfg):
    pose: PoseConfig = Field(default_factory=PoseConfig)
    speech: SpeechConfig = Field(default_factory=SpeechConfig)
    heart: HeartConfig = Field(default_factory=HeartConfig)
    coaching: CoachingConfig = Field(default_factory=CoachingConfig)


def merge_config(overrides: dict | None) -> SessionConfig:
    """Deep-merge user overrides onto defaults; unknown keys are rejected."""
    base = SessionConfig().model_dump()

    def merge(dst: dict, src: dict) -> None:
        for key, value in src.items():
            if isinstance(value, dict) and isinstance(dst.get(key), dict):
                merge(dst[key], value)
            else:
                dst[key] = value

    merge(base, overrides or {})
    return SessionConfig.model_validate(base)

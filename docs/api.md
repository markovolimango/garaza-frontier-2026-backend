# Coaching backend API (v1, schema 1.0)

Machine-readable contract: `contracts/schemas/*.schema.json` (JSON Schema 2020-12), `contracts/openapi.json`,
TypeScript types `contracts/typescript/coach-types.ts` and a minimal client `contracts/typescript/coach-client.ts`.
They are generated from `services/coach/coach/wire.py` and `wsmessages.py` (`bash scripts/coach-contracts.sh`).

Base URL: `http://127.0.0.1:8765` by default (LAN/TLS: `https://<mac>.local:8765`, see [device-setup.md](device-setup.md)).

## 1. Authentication

| Credential | Obtained from | Used for | Transport |
|---|---|---|---|
| Operator token | `services/coach/.runtime/api_token` (0600, generated per run) or `COACH_API_TOKEN` | all REST `/v1/*`, `/v1/stream` | `Authorization: Bearer <token>` |
| Device token (24 h) | `POST /v1/devices/pair` with a single-use pairing code | `/v1/ingest`, `GET /v1/capabilities` | `Authorization` header, or first socket message `{"type":"auth","token":"..."}` |
| Stream ticket (30 s, single use) | `POST /v1/stream-tickets` (operator) | `/v1/stream` from browsers | first socket message `{"type":"auth","ticket":"..."}` |

Rules:

- Tokens never appear in URLs or query strings, and the server never logs them.
- A socket that has not authenticated within 5 s is closed.
- The server stores only SHA-256 hashes of device tokens and tickets.
- Pairing codes are 8 digits, single use and valid for 5 minutes. After 10 failed pairing attempts within 5 minutes, pairing is locked for a while (HTTP 429 `pairing_locked`).
- Browser clients: if a request carries an `Origin` header, the origin must match an entry in `COACH_ALLOWED_ORIGINS` exactly. Otherwise the socket is closed (code 1008) before it is accepted. CORS headers are sent only for listed origins, and wildcards are rejected.
- Native clients send no `Origin` header.

## 2. Errors

Every REST error uses one envelope:

```json
{"error": {"code": "invalid_transition", "message": "cannot pause a session in state 'created'",
           "details": {"state": "created", "action": "pause", "allowed_from": ["running"]}}}
```

| HTTP | code | meaning |
|---|---|---|
| 401 | `unauthorized`, `invalid_pairing_code` | missing or wrong token; bad, used or expired code (`WWW-Authenticate: Bearer`) |
| 404 | `session_not_found`, `not_found` | |
| 409 | `invalid_transition`, `invalid_state` | lifecycle violation |
| 410 | `history_expired` | cursor left the ring buffer (`details.oldest_complete_after_cursor`) |
| 422 | `invalid_request`, `invalid_config` | validation errors in `details.errors` |
| 429 | `too_many_sessions`, `pairing_locked` | limits |

On sockets, errors arrive as `{"type":"error","error":{"code","message"}}`. Socket close codes:

| Code | Meaning |
|---|---|
| 4401 | unauthenticated |
| 1008 | origin or policy violation |
| 1009 | message larger than 256 KiB |
| 1013 | slow consumer: the subscription was closed; reconnect with `after_cursor` |

## 3. REST endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | liveness, no auth |
| GET | `/ready` | readiness, no auth |
| GET | `/v1/capabilities` | event types, rules, `session_config_defaults`, limits, auth modes, assistant status |
| POST | `/v1/pairing-codes` | operator; returns `{code, expires_at}` |
| POST | `/v1/devices/pair` | body `{code, device_id, kind: iphone\|mac\|simulator, name}` returns `{device_token, expires_at}` |
| GET / DELETE | `/v1/devices`, `/v1/devices/{id}` | list paired devices (connection and clock state); revoke |
| POST | `/v1/stream-tickets` | single-use ticket for browser WebSockets |
| GET | `/v1/sessions` | list |
| POST | `/v1/sessions` | body `SessionCreate`, returns 201 with the session |
| GET | `/v1/sessions/{id}` | session (state, timeline, mic_source, simulated, effective config, head_cursor) |
| DELETE | `/v1/sessions/{id}` | erase now: stops it, closes its subscribers, drops its events from memory (the brain bridge calls it when the presenter deletes their practice session); 404 if unknown |
| POST | `/v1/sessions/{id}/start` `pause` `resume` `stop` | `created→running`, `running→paused`, `paused→running`, `created\|running\|paused→ended`; otherwise 409 |
| POST | `/v1/sessions/{id}/calibration/start` | `{duration_s?}`: explicit quiet period for the heart-rate session reference |
| GET | `/v1/sessions/{id}/snapshot` | aggregated state plus `cursor` |
| GET | `/v1/sessions/{id}/events?after_cursor=&limit=&types=` | ordered page: `{events, next_cursor, head_cursor, has_more}`; 410 if expired |
| GET | `/v1/sessions/{id}/summary?narrative=true` | totals; `narrative.source` = `template` or `foundation_models` |
| GET | `/v1/sessions/{id}/export` | JSONL: header line, then retained events (explicit export) |

`SessionCreate` fields:

| Field | Values / default | Notes |
|---|---|---|
| `label` | text | |
| `mic_source` | `iphone`, `mac`, `none` (default `iphone`) | exactly one authoritative microphone |
| `timeline` | `live` (default) or `event_time` | `live` for real devices: rules use the server clock. `event_time` for simulation and replay: corrected event times drive rules (deterministic, may run faster than real time). |
| `simulated` | boolean | simulated and real data never mix; see §7 |
| `config` | object | deep-merged over the defaults in `/v1/capabilities` |

Sample requests: `bash scripts/coach-requests.sh`.

## 4. Event envelope

```json
{"schema_version": "1.0", "cursor": 812, "event_id": "ev-3f2a...", "session_id": "ses_8c1d...",
 "source": {"device_id": "iphone-1a2b", "kind": "iphone", "simulated": false, "relay_device_id": null},
 "sequence": 4711, "event_type": "pose.frame",
 "captured_at": "2026-11-07T20:46:38.017Z", "source_monotonic_ms": 812345.12,
 "received_at": "2026-11-07T20:46:38.061Z",
 "timing": {"clock_basis": "handshake", "clock_offset_ms": -120.0, "clock_uncertainty_ms": 1.1,
            "corrected_captured_at": "2026-11-07T20:46:37.897Z", "out_of_order": false, "late": false},
 "payload": {...}}
```

**Identity and order**

- **`cursor`** is assigned by the server and strictly increases per session. It follows processing order, and control, speech and heart-rate events are processed before pose frames. Sort by `timing.corrected_captured_at` for time order. Do not assume arrival order equals capture order.
- **`event_id`** is unique per source. Resending an event is safe: duplicates are acknowledged but not re-processed.
- **`sequence`** is a per-source counter assigned at first transmission. A gap produces a `system.warning` with code `sequence_gap`; an event that later fills the gap is flagged `out_of_order`.

**Time**

- **`captured_at`** is the original device timestamp and is always preserved.
- **`received_at`** is set by the server.
- **`timing`** maps capture time to the server clock:

| `clock_basis` | meaning |
|---|---|
| `handshake` | NTP-style offset measured on this device's socket |
| `relay_assumed` | relayed Watch timestamps corrected with the iPhone's offset, plus 500 ms of extra uncertainty |
| `server` | server-produced event |
| `none` | no estimate; time is uncorrected |

**Freshness**

- **`late`** means the event was older than its type's staleness limit when it arrived. Defaults: pose 1.5 s, heart rate 20 s, speech 15 s.
- Late events are stored, but they never become "current".

**Clock handshake on `/v1/ingest`**

1. Device sends `clock.ping{t0}`.
2. Server replies `clock.pong{t0,t1,t2}`.
3. Device sends `clock.sample{t0,t1,t2,t3}`.
4. Server replies `clock.estimate{offset_ms, uncertainty_ms}`.

Formulas: `offset = ((t1-t0)+(t2-t3))/2` and `rtt = (t3-t0)-(t2-t1)`. The sample with the smallest round trip wins, and uncertainty = rtt/2 + 1 ms + drift allowance (100 ppm × sample age).

### Event types

| type | producer | payload schema |
|---|---|---|
| `session.state` | server | `SessionStatePayload` |
| `device.status` | device, or server (connect/disconnect, `subject_device_id`) | `DeviceStatusPayload` |
| `pose.frame` | iPhone (Vision) | `PoseFramePayload` |
| `body.metrics` | server, ≤ 2 Hz | `BodyMetricsPayload` |
| `speech.activity` | authoritative microphone (VAD) | `SpeechActivityPayload` |
| `speech.transcript.partial` / `.final` | authoritative microphone | `TranscriptPayload` |
| `speech.metrics` | server | `SpeechMetricsPayload` |
| `heart_rate.sample` | Watch via iPhone | `HeartRateSamplePayload` |
| `heart_rate.state` | server | `HeartRateStatePayload` |
| `coaching.feedback` | server | `CoachingFeedbackPayload` |
| `behavior.episode` | server, at an episode's start and end | `BehaviorEpisodePayload` |
| `audio.playback` | server (Mac assistant) or device | `AudioPlaybackPayload` |
| `system.warning` | server or device | `SystemWarningPayload` |

Devices may send only device-producible types; for example, `coaching.feedback` from a device is rejected.

### Conventions

**Missing values:** `null`, never `0`. Units appear in field names or in `unit` fields: `_s`, `_ms`, `_m`, `_bpm`, `_wpm`, `_deg`, `torso_lengths`.

**Quality states:**

| state | meaning |
|---|---|
| `good` | evaluated on adequate data |
| `limited` | partial data (e.g. some joints missing) |
| `degraded` | method fallback (e.g. no VAD, so the rate uses elapsed time) |
| `insufficient_data` | not enough samples or words to evaluate |
| `stale` | newest data older than its freshness limit |
| `unavailable` | source missing, unauthorized or unreachable |

Rules that depend on data in any of the last three states are suppressed.

## 5. Coordinates

Person-related names (`left_*`, `right_*`) are anatomical, the subject's own side, as defined by Vision. They are never swapped.

### 2D (`coordinate_space_2d: image_normalized_top_left`)

- `x` and `y` lie in 0..1 of the upright image Vision analysed (`image.width/height` in pixels, `image.orientation`). The origin is the top-left corner: x grows right, y grows down. Vision's lower-left origin has been converted.
- `confidence` is Vision's per-joint `VNRecognizedPoint.confidence`, or the YOLO keypoint confidence for frames from `vision/ --coach` (`detector: ultralytics-yolo26*-pose`, `image.camera_position: external`, only the 17 COCO joints: no `neck` or `root`). The two scales are not calibrated against each other.
- **Mirrored overlay** (front-camera style display): `x_display = 1 - x`, `y_display = y`, and keep the joint names. With the back camera, as in this setup, `image.mirrored` is `false`.
- To pixels: `px = x * drawn_width + offset_x` after aspect-fit, and the same for y.

### 3D (`coordinate_space_3d: vision_body_root_m`)

| Field | Meaning |
|---|---|
| `position_m` | meters relative to the root joint (hip center); `root` = [0, 0, 0] |
| `local_position_m` | relative to `parent` (Vision `parentJointName`); `root` has `parent: null` |
| `image_point` | Vision's projection into the image, top-left normalized. It may lie outside 0..1 for joints outside the frame (values near 3 were observed), so clip before drawing. Mirror it the same way as 2D. |
| `root_camera_position_m` | root position relative to the camera (`cameraRelativePosition(.root)`); z grows with distance in front of the camera |
| `camera_origin_matrix` | Vision `cameraOriginMatrix` (root/hip → camera), column-major 4×4 |
| `body_height_m` | 1.8 m reference height unless `height_estimation: measured` (LiDAR depth), so metric scale is approximate |

- **Axes are not documented by Apple.** On this Mac (macOS 26.7.2), with people facing the camera in sample photos, we observed **+x toward the subject's left, +y up, +z toward the camera**. Verify on device before relying on the signs.
- **Confidence:** 3D joints have no per-joint confidence and none is invented. `observation_confidence` passes `VNObservation.confidence` through (1.0 on the test photos; its meaning for 3D is undocumented).
- **Never mix 2D and 3D:** `mode` tells which detector produced a frame. 2D confidences and 3D positions are not comparable, and the backend resets smoothing when the mode changes.

### Movement observations (`body.metrics`)

| Field | Meaning |
|---|---|
| `reference` | median torso length (mid-shoulder to mid-hip, or center_shoulder to root) over 5 s, in image px (2D) or m (3D) |
| `wrist_movement.left/right` | mean wrist speed relative to the torso, in torso lengths per second, over `window_s` |
| `torso_displacement.value` | net torso-center displacement over the window, in torso lengths (`meters` in 3D when the root camera position is present) |
| `torso_movement.value` | mean torso-center speed along its path over `window_s`, in torso lengths per second (walking back and forth does not cancel out; 3D needs the root camera position) |
| `joint_angles_deg` | elbows and shoulders, only when all three joints are valid; `plane: image_2d` is a projected angle, `3d` is a true angle |
| `posture.arms_cross` | both wrists past the body midline towards the other side, the smaller of the two (> 0 = crossed), in torso lengths; `wrist_cross`/`wrist_height` per side (height 0 = shoulder line, 1 = hip line); `arms_in_zone` = both wrists in the chest zone |
| `posture.face_touch_distance` | nearest wrist to a face point (nose, eyes, ears), in torso lengths (2D only) |
| `posture.head_pitch` | nose below the ear line along the torso axis (`head_pitch_source: ears`, or `shoulders` without visible ears), in torso lengths; `head_pitch_reference` = p20 over 60 s (head up for this person and camera), `head_pitch_delta` = pitch − reference (2D only) |
| `posture.arms_crossed` / `face_touch` / `looking_down` | the measure is past its rule threshold right now (no sustain, no hysteresis) |
| `tracking_state` | `tracking`, `partial`, `lost` (fresh frames, no usable body for 1 s), `stale` (no frames for 1.5 s), or `unknown` |

- Smoothing uses a timestamp-aware One-Euro filter and resets after a gap of 0.5 s, after tracking loss or after a 2D/3D mode change.
- Posture values are medians over `posture.window_s` (1 s) and need samples in half of its frames; `null` = unavailable (joints missing, e.g. a wrist hidden under the other arm). The geometry and its reasoning are in `services/coach/coach/metrics/body.py`.
- These are movement and posture observations only; no posture is labelled as an emotion.
- Face touch is a 2D proximity of the wrist keypoint to the face (no hand landmarks, no depth): a hand held in front of the face counts too.

## 6. Speech, heart rate, coaching

**Speech (`speech.metrics`)**

- `final.*` comes from finalized transcripts only and is authoritative. `provisional.*` includes partial results and is never used by rules.
- A newer revision of an utterance replaces the older one, so revisions are never double counted.
- `final.rate_wpm` = final words ÷ speech-active minutes, in a window that ends at the last finalized word (`window_end_at`). Without VAD, `rate_basis: elapsed_running_time` and quality is `degraded`.
- Pauses are silences between two VAD speech intervals inside one running segment. Time before start, time while paused and synthesized-playback intervals never count; transcription callback delays never create pauses.
- The VAD is the device's energy-threshold heuristic: noise and other voices count as speech.
- Filler lexicons are per language (`en`, `sr`) and can be overridden in the config (`speech.filler_lexicon`). Recognizers may omit disfluencies such as "um", so counts can be low.

**Playback suppression (`audio.playback`)**

- From `started` until `finished`, `interrupted` or `skipped` plus `playback_tail_s` (0.6 s), speech activity, words and pauses are ignored.
- If the assistant never confirms the end, the backend emits `interrupted` and closes the interval.
- A suggestion that becomes obsolete before playback is `skipped`.

**Heart rate**

- `heart_rate.sample` keeps `measured_at`, `collection_mode` (`passive_healthkit`, `workout_session` or `simulated`), `delivery` (`live_message`, `queued_transfer`, `application_context` or `direct`) and `sample_age_ms_at_send`.
- `heart_rate.state.reference` is a **session reference** from an explicit quiet calibration: the median of at least 5 fresh samples. It is not a clinical resting heart rate.
- `above_reference` is evaluated only with fresh samples (at most 20 s old, at least 3 in the 30 s window).
- HRV: `{"status":"unavailable"}` unless the device sends a HealthKit SDNN value, which is passed through as context. HRV is never computed from bpm.

**Coaching (`coaching.feedback`)**

Each suggestion contains: `rule_id`, `evidence_event_ids`, `observation`, `suggested_action` (both deterministic), `display_text` with its `text_source` (template, or Foundation Models rephrasing), `priority`, `quality_state`, `cooldown{rule_cooldown_s, next_eligible_at, rearm, global_min_interval_s, sustained_s}` and `expires_at`.

Selection rules:

- At most one suggestion is active at a time (`display_s`).
- The highest priority wins.
- After firing, a rule must first clear (hysteresis) and wait for its cooldown before it can fire again.
- Body movement and posture rules need a visible body (`tracking` = good, `partial` = limited quality); without enough frames in the window they are suppressed, never guessed. Their thresholds are demo heuristics, not validated on real devices; tune them per session under `config.pose` (the brain bridge and `python -m coach tune` pass `services/coach/tuning.json`).

| rule | condition (defaults = demo heuristics) | priority |
|---|---|---|
| `body.tracking_lost` | `tracking_state = lost` for 3 s (fresh frames) | 1 |
| `body.hand_movement_high` | faster wrist > `pose.hand_movement_high_per_s` (1.5 torso lengths/s, relative to the torso) for 10 s; clears below 1.0 | 3 |
| `body.torso_movement_high` | `torso_movement` > `pose.torso_movement_high_per_s` (0.4 torso lengths/s) for 10 s; clears below 0.25 | 3 |
| `body.arms_crossed` | `posture.arms_cross` ≥ `pose.arms_crossed_min_cross` (0.10) with both wrists in the chest zone, for 3 s; clears when a wrist is back to the midline (< 0) or leaves the zone | 3 |
| `body.face_touch` | `posture.face_touch_distance` ≤ `pose.face_touch_max_distance` (0.35) for 1 s; clears beyond 0.5 | 3 |
| `body.looking_down` | `posture.head_pitch_delta` ≥ `pose.looking_down_min_delta` (0.06, ~20° of head tilt) for 3 s; clears below 0.03; unavailable until the head-up reference has 5 s of history | 3 |
| `speech.rate_high` | final rate > `target_wpm_max` (165) for 8 s; clears below 153 | 2 |
| `speech.long_pauses` | ≥ 3 pauses ≥ 2 s in 60 s while speaking | 3 |
| `speech.fillers` | ≥ 4 fillers in 60 s (final transcripts) | 3 |
| `heart.above_reference` | median of fresh samples ≥ reference + 15 bpm for 30 s | 4 |

Texts state observations ("Heart rate is above your session reference (+18 bpm).") and never claim emotions, stress or health conditions.

**Behaviour episodes (`behavior.episode`)**

The record of what happened, separate from the throttled coaching rules: every occurrence counts, several
behaviours can be open at once, and each episode has its own times. One event when an episode starts and one
when it ends, with the same `episode_id`.

- `started_at` is when the condition began to hold (it must hold `min_on_s` before the start event is sent);
  `ended_at` is when it was last seen (it must be clear `min_off_s` before the end event is sent).
- `end_reason`: `cleared`, `tracking_lost` (no usable joints for `episodes.unknown_grace_s`, 1.5 s),
  `session_paused` or `session_ended` (open episodes close before the `session.state` event).
- Missing measures are unknown, never "not happening": they cannot start an episode.
- Measures and thresholds are the coaching rules' own (`body.metrics`, `config.pose`, so `tuning.json` tunes
  both): an episode starts at the rule's condition and ends at its clear threshold. Only the timing is
  separate (`config.episodes`). Posture measures are 1 s medians, so a start lags the real onset by ≈0.5 s.

| behavior | condition (same as the rule) | episode timing (`config.episodes`) |
|---|---|---|
| `arms_crossed` | `body.arms_crossed`: both wrists across the midline in the chest zone | on 1 s, off 1 s |
| `face_touch` | `body.face_touch`: nearest wrist to a face point | on 0.5 s, off 0.5 s |
| `looking_down` | `body.looking_down`: head pitch against the head-up reference | on 1.5 s, off 1 s |
| `sway` | `body.torso_movement_high`: torso-center speed (walking counts too) | on 2 s, off 1.5 s |
| `fast_hands` | `body.hand_movement_high`: faster wrist, relative to the torso | on 2 s, off 1.5 s |

The session summary has per-behaviour `episodes`, `total_s`, `longest_s`. The brain bridge forwards each
episode as the brain's `behavior` start/end with the episode's own times, and sends a green reward vignette
when an episode of one of the run's targets clears.

## 7. WebSockets

### `/v1/ingest` (devices)

```
→ (Authorization header) | {"type":"auth","token":"<device token>"}
← {"type":"auth.ok","device_id":...,"limits":{"max_message_bytes":262144,"max_batch_events":100}}
→ clock.ping / clock.sample (x5)          ← clock.pong / clock.estimate
→ {"type":"join","session_id":null}       ← {"type":"session","session":{session_id,state,mic_source,language,pose_rate_hz,...}}
→ {"type":"events","events":[EventIn,...]} ← {"type":"ack","results":[{"event_id","status":"accepted|duplicate|rejected","code?","retryable?"}]}
← {"type":"session",...}                  (pushed on every state change: start capture on running, stop on paused/ended)
← {"type":"backpressure","state":"on|off","lane":"pose"}
```

- `join` with `session_id: null` joins the newest session that has not ended.
- **Two-lane queue per session:**
  - control, speech and heart-rate events: bounded to 2,000; when full, `queue_full` with `retryable: true`;
  - pose frames: bounded to 64; the oldest is dropped first and counted in `counters.dropped_pose_frames`.
- Backpressure turns on at 75 % pose-lane fill and off at 25 %.
- Recommended device behaviour (implemented in `CoachConnection`):
  - keep high-priority events until acknowledged and re-send them after reconnecting;
  - drop stale pose frames;
  - send only the newest frame while backpressure is on.
- `source.device_id` must equal the authenticated device. The exception is relayed Watch samples: `kind: watch, relay_device_id: <iPhone id>`.
- Simulator credentials must send `simulated: true`, and real devices must not. A session never mixes simulated and real data.
- Speech events are accepted only from the session's `mic_source` kind and from the first device that sends speech.

### `/v1/stream` (frontends)

```
→ (Authorization header) | {"type":"auth","token"|"ticket":...}
← {"type":"auth.ok","role":"operator|ticket"}
→ {"type":"subscribe","session_id":"<id>|latest","event_types":["coaching.*","speech.metrics"],"after_cursor":812|null}
← {"type":"history_expired",...}        (only if after_cursor < oldest retained)
← {"type":"snapshot","cursor":H,"snapshot":{...}}
← {"type":"event","event":{...},"replay":true}   (retained events with after_cursor < cursor ≤ H)
← {"type":"synced","cursor":H}                    history/live boundary
← {"type":"event","event":{...}}                  live, cursor > H
← {"type":"heartbeat","cursor":...}               every 15 s when idle
```

- **Atomic boundary:** the snapshot, the replay slice and the subscription registration share one cursor `H`, so nothing is lost or duplicated at the boundary.
- **On reconnect**, resubscribe with the last cursor you received:
  - replace UI state with the new snapshot;
  - append replayed events to your timeline;
  - after `history_expired`, reset the timeline.
- Pose frames in history are best effort (short buffer of 600 frames). Other events are retained up to 20,000 per session.
- **Slow consumers:** when a subscriber queue (2,000) is full, `pose.frame` and `body.metrics` are dropped and counted. Any other overflow closes the subscription with code 1013.

## 8. Storage, export, replay, simulation

- **Memory:** in-memory and bounded (event ring, pose ring, ingest queues). Sessions are removed 2 h after ending or after 2 h idle (`COACH_SESSION_TTL_S`). No raw audio or video is persisted.
- **Export:** `GET /export` is an explicit JSONL export of the retained events. The header records `evicted_pose_frames`; if it is greater than 0, the export is incomplete.
- **Replay:** `python -m coach replay file.jsonl[.gz] --strict` feeds the device events into a fresh `event_time` session, recomputes metrics and coaching, and compares them with the recorded suggestions.
- **Simulation:**
  - simulated data carries `source.simulated: true`, and the session has `simulated: true`; server-derived events of such a session inherit `source.simulated: true`;
  - real devices cannot write into a simulated session, and simulators cannot write into a real one.

# Architecture

```
 Apple Watch (WatchSensors)            iPhone (CaptureIOS = CoachCaptureKit)             Mac
 ─ HealthKit heart rate                ─ AVFoundation camera → Vision pose (3D, 2D fb)   services/coach (FastAPI)
 ─ explicit workout session  ──WC/──▶  ─ AVAudioEngine → energy VAD + SFSpeech (on-dev)  ─ sessions, ingest queues
   + mirroring             mirroring   ─ Watch relay (HeartSampleRelay)        ──wss──▶  ─ metrics, coaching rules
                                       ─ CoachConnection (clock, queues, acks)  /ingest  ─ REST + /v1/stream ──▶ future UI
                                                                                         ─ JSONL export / replay
                                       MacAssistant (127.0.0.1:8766) ◀──HTTP── backend   ─ simulator (no hardware)
                                       ─ AVSpeechSynthesizer, Foundation Models
```

| Path | Responsibility |
|---|---|
| `services/coach/coach/wire.py` | versioned contract (source of `contracts/`) |
| `services/coach/coach/session.py` | lifecycle, admission (validation, auth, dedup, sequences, clock correction, staleness), two-lane bounded queue, worker, publishing, snapshot, summary |
| `services/coach/coach/metrics/` | body (One-Euro, torso-normalised wrist and torso movement), speech (VAD intervals, revisions, rate, pauses, fillers, suppression), heart (session reference, freshness) |
| `services/coach/coach/coaching.py` | deterministic rules (tracking lost, hand movement, walking, speaking rate, pauses, fillers, heart rate): duration thresholds, hysteresis, cooldowns, priority, one at a time, quality suppression |
| `services/coach/coach/eventlog.py` | cursor ring buffers (events, short pose history) |
| `services/coach/coach/api.py` | REST, `/v1/ingest`, `/v1/stream`, auth, origin checks, backpressure messages, ticker for live sessions |
| `services/coach/coach/assistant.py` | optional Mac assistant adapter, safety filter, playback queue and suppression |
| `services/coach/coach/simulator.py`, `export.py` | scenario (networked and in-process), export, deterministic replay |
| `apple/Shared/Wire` | Codable wire models, Watch link, relay/outbox policies (all platforms) |
| `apple/Shared/Transport` | WebSocket client, clock sync, pairing, Keychain, diagnostics |
| `apple/Shared/Capture` | Vision pose adapter, camera capture with one in-flight request |
| `apple/Shared/Speech` | energy VAD, on-device transcription |
| `apple/Shared/Assistant` | TTS, Foundation Models (runtime-checked) |
| `apple/Shared/CaptureKit` | iPhone orchestration and minimal SwiftUI controls (also compiles on macOS) |
| `apple/CaptureIOS`, `apple/WatchSensors` | thin app targets, Info.plist and entitlements (`project.yml`) |
| `apple/MacAssistant`, `apple/Tools/*` | helper server, Vision probe, transport probe |
| `vision/` (`coach_link.py`) | second pose producer: Mac camera (e.g. iPhone via Continuity Camera) + Ultralytics YOLO26 (2D, PyTorch/MPS) → `/v1/ingest` `pose.frame`, `source.kind: mac`; auto-pairs on the same Mac |

## Design decisions

- **Time:** the backend is authoritative. Each event keeps its device timestamp, the server receipt time and a corrected event time with uncertainty.
  - `live` sessions evaluate time-based rules on the server clock, with ticks every 0.5 s.
  - `event_time` sessions (simulation, replay) use corrected event times and process in arrival order for determinism.
- **Prioritisation:** ingest admission is synchronous. Control, speech and heart-rate events have their own lane, and pose frames (high rate, freshness matters more than completeness) have a bounded lane that drops the oldest. Drops, gaps, duplicates and late events are counted and exposed in snapshots and summaries.
- **Determinism:** metrics are recomputed for each evaluation time, with no time-dependent caching. Exports replay to the same coaching sequence; a test checks this, including against the committed fixture.
- **Optional parts never block the baseline:** the Watch, Foundation Models and TTS sit behind adapters with timeouts and template fallbacks.
- **One pose source per session:** the iPhone app (Apple Vision, 2D/3D) and `vision/ --coach` (YOLO26, 2D) both send `pose.frame`; use one of them in a session, since the body tracker does not merge two cameras.
- **Video:** only landmarks are transmitted. A future camera preview UI needs a separate video transport, for example WebRTC or HLS from the phone, with its own consent and permissions. That is out of scope.

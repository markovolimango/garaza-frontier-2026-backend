# Platform notes: verified facts, measurements, limitations

Each fact is labelled by how it was established:

- **[SDK]**: read from the macOS 26.5 SDK headers or Swift interfaces in the installed Command Line Tools.
- **[Measured]**: run on this MacBook Pro (M1 Pro, macOS 26.7.2, Swift 6.3.3).
- **[Docs]**: Apple documentation as of 2026-11-07 (URLs at the end).
- **[Not tested]**: needs physical hardware or SDKs that are not installed.

## Development environment

- **Command Line Tools only, no Xcode.** There is no iOS or watchOS SDK, so `CaptureIOS` and `WatchSensors` were **not compiled**.
- **[Measured]** Everything in the `CoachKit` Swift package compiles for macOS and its 19 Swift Testing tests pass (`scripts/apple-check.sh`, which now exits non-zero when the build or a test fails and never runs binaries from an older build). That covers Wire, Transport, Capture, Speech, Assistant and CaptureKit, including the SwiftUI controls. iOS-only branches (`AVAudioSession`, `AVAudioApplication` record permission, `UIApplication` idle timer, WatchConnectivity, workout mirroring) are excluded from the macOS build and are therefore not compiled either.
- **[Measured]** The macOS build has no warnings with `-strict-concurrency=complete` and also builds with `-swift-version 6`. The package and app targets stay in Swift 5 language mode because the iOS/watchOS-only code cannot be compiled here.
- Backend: Python 3.13.18 (arm64). Exact versions are in `services/coach/requirements.lock.txt`.
- No Node.js is installed, so the TypeScript client and types were **not type-checked**.

## Vision body pose

- **[SDK]** `VNDetectHumanBodyPose3DRequest`: macOS 14 / iOS 17.
  - 17 joints: root, left/right hip, knee, ankle, spine, center_shoulder, center_head, top_head, left/right shoulder, elbow, wrist.
  - `position` is relative to the root (hip) in meters; `localPosition` is relative to the parent joint.
  - Also available: `pointInImage` (normalized, lower-left origin), `cameraOriginMatrix`, `bodyHeight` (1.8 m reference unless measured with LiDAR depth) and `heightEstimation`.
  - **No per-joint confidence.**
- **[SDK]** `VNDetectHumanBodyPoseRequest`: macOS 11 / iOS 14. 19 joints with `VNRecognizedPoint.confidence`.
- **[Measured]** On this Mac, using Ultralytics sample photos (still images, full 3D/2D pipeline in `vision-probe`):

| Request | First call | Later calls | Result |
|---|---|---|---|
| 3D | 204 ms | 83–94 ms | 1 person, 17 joints; `observation_confidence` 1.0 |
| 2D | 9.5 s cold start in a fresh process | ~11 ms | up to 2 persons |

  - The app should warm up the 2D request before a session; the iPhone will differ.
  - Root `parentJointName` is the root itself (mapped to `null`).
  - `pointInImage` for joints outside a cropped photo reached y ≈ 3.04. The contract allows −10..10 and clients must clip.
  - Axis signs observed with people facing the camera: **+x toward the subject's left, +y up, +z toward the camera**. Apple does not document these. Verify on device.
- **[SDK]** Camera buffers are rotated with `AVCaptureDevice.RotationCoordinator` (`videoRotationAngleForHorizonLevelCapture`, iOS 17 / macOS 14), which follows the device's physical orientation, so portrait and landscape mounts both give upright frames. **[Not tested]** on an iPhone.
- **[Not tested]** iPhone camera frame rate, Vision timings on A16, thermal behaviour. The default rate is 12 pose observations per second, configurable (`pose.target_rate_hz`, app stepper). No FPS is promised.
- **Neural Engine:** Vision schedules its own models, and nothing here verifies whether the requests run on the Neural Engine, GPU or CPU. Only timings are reported. The Apple apps use no Core ML model or YOLO dependency. The separate Mac prototype `vision/` does use Ultralytics YOLO26 through PyTorch (MPS or CPU) and can feed the same backend with `--coach`.

## Speech

- **[Docs]** `requiresOnDeviceRecognition` is honoured only when `supportsOnDeviceRecognition` is true. The app checks both and **does not start transcription** instead of using server recognition. The microphone and the VAD keep running (`speech.activity` only, plus a `transcription_unavailable` warning).
- Recognition requests are rotated every 50 s; the next request starts before the old one ends, so no audio falls between them. A recognizer that fails within 5 s without results is restarted with exponential backoff (0.5 s to 15 s), reset after a result.
- The microphone permission is checked before the audio tap is installed (`AVAudioApplication.recordPermission` on iOS 17, `AVCaptureDevice` audio authorization on macOS); an input format with 0 Hz or 0 channels is reported, not tapped.
- **[Docs, not confirmed at runtime]** Serbian is not in Apple's dictation language list, so `SFSpeechRecognizer` for `sr-RS` is expected to be unavailable. The app reports the exact runtime reason.
- The newer `SpeechAnalyzer` / `SpeechTranscriber` (iOS / macOS 26) is not used yet; it is a future adapter.
- **[Not tested]** Microphone capture, recognition quality and latency on the iPhone. A CLI process cannot request speech authorization (no Info.plist), so recognition was not exercised on the Mac.
- VAD: an energy-threshold heuristic (`energy_threshold_heuristic_v1`) with a 1.5 s noise-floor calibration, a +10 dB margin, a 150 ms start hold, a 450 ms hangover and a 3 dB release band. Levels are clamped to [-100, 0] dBFS (float audio can exceed full scale; the contract requires `level_dbfs <= 0`). Noise, other voices and the synthesizer count as speech. Synthesizer audio is handled by the explicit playback suppression intervals. The logic is unit-tested with synthetic levels.

## Text to speech and Foundation Models (Mac helper)

- **[Measured]** `AVSpeechSynthesisVoice.speechVoices()`: 180 voices in 49 languages, **no Serbian voice** (Croatian `hr-HR` exists). Serbian text is skipped, never spoken with another language's voice. A silent render of an English sentence took 2.3 s of audio.
- **[Docs]** The synthesizer must be retained until speech ends; it is a stored property.
- **[Measured]** Foundation Models on this Mac: `SystemLanguageModel.default.availability == .available`. `supportsLocale`: `en` true, **`sr` false**, so the helper returns `unsupportedLanguage`. Supported languages include da, de, en, es, fr, it, ja, ko, nb, nl, pt, sv, tr, vi and zh.
  - Structured generation (`DynamicGenerationSchema` → `{text}`) worked. `@Generable` macros cannot be built with Command Line Tools because the macro plugin is missing.
  - Latency of the first three rephrase calls: **10.2 s, 6.8 s, 3.7 s**. After `prewarm()` and warm-up, a backend rephrase fit the 2.5 s budget and a summary took 1.7 s.
  - Timeouts return promptly (0.2 s budget gave the answer in 0.27 s), and the backend then falls back to templates.
- **[Docs]** Apple Intelligence devices do **not include iPhone 14 Pro** (iPhone 15 Pro, iPhone 16 and later, iPhone Air, iPhone Duo). Macs with M1 or later are supported. That is why Foundation Models runs only in the Mac helper.
- Model output is used only for `display_text` and session narratives. The backend rejects outputs that mention emotions, stress, anxiety or medical topics, add numbers, or exceed length limits. Measurements and rule decisions never come from the model.

## Apple Watch heart rate

- **[Docs]** Outside workouts, watchOS decides when heart rate is measured. No public API triggers an on-demand measurement. Background delivery on watchOS is limited (most types hourly; `heartRate` is not in the immediate list).
  - The app uses `HKAnchoredObjectQuery` with `updateHandler` while running (best effort, labelled `passive_healthkit`) and shows each sample's age.
- **[Docs]** Workout sessions produce high-frequency heart-rate samples. They need the `workout-processing` background mode plus `NSHealthShareUsageDescription` and `NSHealthUpdateUsageDescription`.
  - Mirroring: `startMirroringToCompanionDevice()` (watchOS 10) and `HKHealthStore.workoutSessionMirroringStartHandler` (iOS 17).
  - Data travels through `sendToRemoteWorkoutSession(data:)` and `workoutSession(_:didReceiveDataFromRemoteWorkoutSession:)`. While the iPhone app is suspended, delegate calls can be minutes apart.
  - The workout mode is explicit and user-started, with an activity picker and Save/Discard. It is never started just to sample more often while speaking.
- **[Docs]** WatchConnectivity: `sendMessage` requires `isReachable`; `updateApplicationContext` keeps only the latest state; `transferUserInfo` is a queued FIFO; background timing is not guaranteed.
- HRV: never computed from bpm; passed through only if a HealthKit SDNN sample is sent, and marked unavailable otherwise.
- During a workout each sample reaches the iPhone twice (WatchConnectivity and mirroring). `HeartSampleRelay` de-duplicates by HealthKit UUID, or by measurement time (ms) and bpm for workout-builder statistics, which have no UUID (unit-tested).
- The Watch source id is `watch-<iPhone device id>` for every path. The mirroring start handler is set in `CaptureIOSApp.init` (at launch, including background launches). The iPhone app does not request HealthKit authorization; whether mirroring requires it is **[Not tested]**.
- **[Not tested]** Everything on a real Watch: authorization, sampling, mirroring, connectivity. The exact Watch model and OS are unknown.

## Networking and security

- **[Docs]** iOS 17 ATS no longer allows IP-address hosts by default. `NSAllowsLocalNetworking` permits unqualified, `.local` and IP hosts. The local-network prompt (`NSLocalNetworkUsageDescription`) applies to direct TCP connections to LAN hosts.
  - Whether ATS covers `URLSessionWebSocketTask` `ws://` explicitly is not confirmed by the docs; plaintext is development-only.
- **[Measured]** The backend binds 127.0.0.1 by default. LAN mode refuses to start without TLS unless `--allow-insecure-lan` is given. The Mac helper is reachable only on loopback (connection from the LAN IP refused) and requires a bearer token.
- **[Measured]** Mac helper request limits: `Content-Length: -5` gets 400 (it used to crash the helper before authentication), `Content-Length: 999999` gets 413, garbage gets 400, and a client that sends nothing gets 408 after 10 s. The helper keeps running. Limits: 16 KiB of headers, 64 KiB body, 32 open connections.
- **[Measured]** The Swift transport (`ingest-probe`) paired with the Python backend, did the clock handshake (offset 0.00 ± 1.1 ms on loopback), joined and sent 21 events: 21 accepted, 0 rejected.
- Transport behaviour (`CoachConnection` + `OutboundQueue`, unit-tested where marked):
  - `join` is re-sent every 2 s while the server answers `no_active_session` / `session_not_found` or the joined session has ended (unit-tested decision). **[Measured]** `ingest-probe --sessions 2 --wait-session 25` started before any session existed, joined the first session once it was created, then joined a second session after the first was stopped: 32 sent, 32 accepted, 0 rejected.
  - Batches are capped at 50 events and 192 KiB of encoded JSON (server limit 256 KiB). Events are encoded before they count as unacknowledged; an unencodable event or one larger than the limit is dropped and counted (unit-tested).
  - Retryable rejections (`queue_full`) are re-sent on the live connection after 1 s (unit-tested).
  - An application `ping` goes out every 10 s; no message for 25 s means the socket is dead. Every failed socket is cancelled. Reconnect backoff (0.5 s up to 10 s) resets after each successful connect.
  - Sequence numbers are per source and stay monotonic across Connected toggles and app restarts (persisted in UserDefaults; unit-tested).

## Sources

- support.apple.com/en-us/120277, /121115 (heart rate measurement; Apple Intelligence devices and languages)
- developer.apple.com/documentation/healthkit: hkanchoredobjectquery, enablebackgrounddelivery(for:frequency:withcompletion:), running-workout-sessions, hkworkoutsession (+ init(healthstore:configuration:), startmirroringtocompaniondevice(completion:), sendtoremoteworkoutsession(data:completion:)), hkhealthstore/workoutsessionmirroringstarthandler, building-a-multidevice-workout-app
- developer.apple.com/documentation/watchconnectivity/wcsession
- developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking, nslocalnetworkusagedescription, wkbackgroundmodes; technotes/tn3179-understanding-local-network-privacy
- developer.apple.com/documentation/foundationmodels/systemlanguagemodel (availability, supportslocale(_:)), generable
- developer.apple.com/documentation/speech/sfspeechrecognizer (supportsondevicerecognition), sfspeechrecognitionrequest/requiresondevicerecognition, speechanalyzer
- developer.apple.com/documentation/avfaudio/avspeechsynthesizer

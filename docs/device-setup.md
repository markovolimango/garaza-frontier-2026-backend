# Physical iPhone and Apple Watch setup

Nothing here was tested with physical devices. This environment has no Xcode, iOS or watchOS SDKs,
camera, microphone, or Watch. The steps follow Apple's documentation and the code in `apple/`.

## 0. What runs where

| Device | App | Sends |
|---|---|---|
| iPhone 14 Pro (iOS 17+) | `CaptureIOS` (camera + Vision, microphone + Speech, Watch relay) | `/v1/ingest` over Wi-Fi to the Mac |
| Apple Watch (watchOS 10+) | `WatchSensors` (HealthKit heart rate) | WatchConnectivity / workout mirroring to the iPhone |
| Mac | backend (`scripts/coach-serve.sh`), optional `MacAssistant` | REST / WebSocket for a future UI |

**`localhost` on the iPhone is the iPhone itself.** Use the Mac's LAN address or its `.local` name.

## 1. Mac backend on the LAN with TLS (recommended)

```bash
bash scripts/coach-setup.sh                     # venv + dependencies + tests
bash scripts/make-dev-cert.sh                   # local CA + certificate for <LocalHostName>.local and the LAN IP
bash scripts/coach-serve.sh --lan \
  --tls-cert services/coach/.runtime/tls/server.crt --tls-key services/coach/.runtime/tls/server.key
```

- Allow incoming connections for Python if the macOS firewall asks.
- Trust the development CA on the iPhone:
  1. Send `services/coach/.runtime/tls/ca.crt` to the phone (AirDrop or Mail). Never share `ca.key`.
  2. Settings > General > VPN & Device Management: install the profile.
  3. Settings > General > About > Certificate Trust Settings: enable full trust for "garaza-frontier coach dev CA".
- The URL in the app is `https://<LocalHostName>.local:8765`, as printed by `make-dev-cert.sh`.
- `NSAllowsLocalNetworking` is declared because iOS 17+ App Transport Security rejects IP-address hosts otherwise. It applies only to local-network hosts.

**Development-only plaintext:**

```bash
bash scripts/coach-serve.sh --lan --allow-insecure-lan   # loud warning; tokens unencrypted
```

Use `http://<mac-ip>:8765` only on a trusted network, and never for real data.

## 2. Build the apps (Xcode required)

1. Install Xcode from the App Store, with the iOS and watchOS platforms, then run `sudo xcode-select -s /Applications/Xcode.app`.
2. Install XcodeGen (`brew install xcodegen`), then run `cd apple && xcodegen generate && open Coach.xcodeproj`.
3. For both targets, set the **bundle identifiers** in `project.yml` or Xcode (they replace `com.example.garazacoach`) and choose your **Team** in Signing & Capabilities. No signing identities are stored in the repo.
4. HealthKit capability: required by `WatchSensors`. `CaptureIOS` needs it only for workout mirroring; remove the entitlement and `WorkoutMirroringReceiver.swift` if you do not use mirroring. HealthKit may not be available to free (personal) teams; Xcode shows this.
5. Deployment targets are iOS 17.0 (Vision 3D body pose, workout mirroring) and watchOS 10.0 (mirroring). Run on the iPhone; the Watch app is embedded and installs through the Watch app on the iPhone.

## 3. Pair and connect the iPhone

```bash
bash scripts/coach-pair.sh            # prints an 8-digit code, valid 5 minutes, single use
```

1. In **Coach Capture**, enter the backend URL and the code, then tap **Pair**. The device token is stored in the Keychain.
2. Tap **Request camera, microphone and speech access**.
3. Turn **Connected** on. iOS asks for **Local Network** access; allow it, or the connection fails with a "cannot reach" diagnostic.
4. Create and start a session on the Mac, before or after step 3 (the order does not matter). While the server has no session, the app shows "waiting for a session" and re-sends `join` every 2 s; when a session ends, it joins the next one by itself. Capture starts when the session is `running`, and the screen stays awake (idle timer disabled) while capturing:

```bash
cd services/coach
.venv/bin/python -m coach request POST /v1/sessions --json '{"label":"rehearsal","mic_source":"iphone"}'
.venv/bin/python -m coach request POST /v1/sessions/<id>/start
bash ../../scripts/coach-stream.sh      # watch pose.frame / body.metrics / speech.* arrive
```

5. Mount the iPhone steadily, in portrait or landscape, with the back camera facing you and your whole upper body in frame. Frames are rotated to be level with the horizon from the phone's physical orientation, so a landscape tripod works even though the UI stays portrait.
6. The app shows:
   - the pose mode (3D, or the 2D fallback with its reason);
   - inference time;
   - the clock offset ± uncertainty;
   - sent / accepted / dropped / rejected / retried counts (plus events dropped as oversize or unencodable), and the last rejection reason;
   - backpressure.

**Speech:**

- Transcription runs on device only and never falls back to the cloud. If the language has no on-device recognizer (or speech permission is missing), the microphone and the VAD still run: the app sends `speech.activity`, shows "VAD only, no transcription: <reason>" and sends one `system.warning` with code `transcription_unavailable`. No transcripts are sent.
- Without microphone permission the app captures no audio and reports `microphone_unavailable` (it does not crash).
- Serbian (`sr-RS`) is expected to be unsupported (verify in the app). The backend Serbian filler lexicon is used only if Serbian transcripts arrive. Speech/silence from the VAD still works.
- If the recognizer fails right after starting (e.g. dictation disabled), it is retried with growing delays (0.5 s up to 15 s) instead of in a tight loop.

## 4. Apple Watch

1. Open **Coach Sensors** on the Watch and tap **Allow heart rate**. Only heart-rate read permission is requested; HRV is not requested by default.
2. **Passive samples (default):** watchOS decides when heart rate is measured outside workouts, so samples can be minutes apart. No public API triggers a measurement on demand. Freshness is shown on every sample, and stale data suppresses heart-rate rules.
3. **Workout (explicit):** choose an activity that really applies, then tap Start. It records a workout in Health and gives frequent samples (no fixed rate is promised). At the end, choose **Save** or **Discard**. The session is mirrored to the iPhone (`direct` delivery). The same samples also arrive over WatchConnectivity; the iPhone keeps only the first copy (keyed by HealthKit UUID, or by measurement time and bpm for workout statistics). Do not start a workout just to get frequent pulse readings while speaking.
4. Delivery labels:

| Path | Label |
|---|---|
| live message, while reachable | `live_message` |
| backlog after reconnect | `queued_transfer` |
| latest state while unreachable | `application_context` |

   Delayed data is never shown as live.

5. A disconnected Watch or a missing permission does not stop pose or speech capture.
6. Heart-rate events use the source id `watch-<iPhone device id>` with the iPhone as `relay_device_id`.
7. The iPhone registers the workout-mirroring handler at app launch. It does not request HealthKit authorization itself; whether mirroring needs that on the iPhone is not verified on a device.

## 5. Optional Mac assistant (speech + Foundation Models)

```bash
bash scripts/assistant.sh            # 127.0.0.1:8766, token file shared with the backend
bash scripts/assistant.sh --silent   # render speech without playing it
```

Enable per session with `{"config":{"coaching":{"speak":true,"rephrase_with_assistant":true}}}`. If the helper is not running, the backend uses text-only templates.

The helper listens on 127.0.0.1 only. It accepts at most 16 KiB of headers and a 64 KiB body, needs the whole request within 10 s and allows 32 open connections; malformed requests get 400/413/431/501 before authentication. `assistant.sh` refuses to start an old binary if the build fails.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Status "waiting for a session" | no session exists or the last one ended: create (and start) one on the Mac; the app joins within about 2 s |
| "Cannot reach host" | backend not started with `--lan`, different Wi-Fi, macOS firewall, or the app's Local Network permission is off |
| TLS failed | CA not installed or not fully trusted, or the certificate lacks the host name: rerun `make-dev-cert.sh` |
| ATS blocked plaintext | use https/wss, or keep `NSAllowsLocalNetworking` (local network only) |
| `not_authoritative_microphone` | the session's `mic_source` is not `iphone`, or another device already sends speech |
| `simulation_mismatch` | a real device was paired as `simulator`, or it joined a simulated session |
| Token rejected | tokens expire after 24 h or are revoked (`DELETE /v1/devices/{id}`); pair again |

# apple/: native Apple components

| Path | Contents | Build here? |
|---|---|---|
| `Package.swift` (CoachKit) | Wire, Transport, Capture (Vision), Speech, Assistant, CaptureKit (iPhone logic + SwiftUI controls) | yes, macOS: `bash scripts/apple-check.sh` |
| `MacAssistant/` | loopback HTTP helper: AVSpeechSynthesizer + Foundation Models | yes: `bash scripts/assistant.sh` |
| `Tools/VisionProbe`, `Tools/IngestProbe` | real Vision on photos; Swift transport against the backend | yes |
| `CaptureIOS/` | iOS app target (entry point, workout mirroring, Info.plist, entitlements) | needs Xcode + iOS SDK |
| `WatchSensors/` | watchOS app (HealthKit, explicit workouts, WatchConnectivity) | needs Xcode + watchOS SDK |
| `project.yml` | XcodeGen spec for the two app targets | `xcodegen generate` |

Device setup and signing: [../docs/device-setup.md](../docs/device-setup.md). Verified APIs and
measurements: [../docs/platform-notes.md](../docs/platform-notes.md).

```bash
swift run vision-probe photo.jpg --mode auto          # 3D with 2D fallback, timings, joint dump
swift run MacAssistant --check                        # voices, Foundation Models availability
```

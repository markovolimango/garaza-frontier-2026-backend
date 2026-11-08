// swift-tools-version: 5.10
// CoachKit: shared Swift code for the iOS capture app, the watchOS sensor app and the macOS helper.
// Builds and tests on macOS with Command Line Tools (scripts/apple-check.sh). The iOS / watchOS app
// targets are generated from project.yml (XcodeGen) and need full Xcode with those SDKs.
import PackageDescription

let package = Package(
    name: "CoachKit",
    platforms: [.iOS(.v17), .watchOS(.v10), .macOS(.v14)],
    products: [
        .library(name: "CoachWire", targets: ["CoachWire"]),
        .library(name: "CoachTransport", targets: ["CoachTransport"]),
        .library(name: "CoachCapture", targets: ["CoachCapture"]),
        .library(name: "CoachSpeech", targets: ["CoachSpeech"]),
        .library(name: "CoachAssistantKit", targets: ["CoachAssistantKit"]),
        .library(name: "CoachCaptureKit", targets: ["CoachCaptureKit"]),
        .executable(name: "MacAssistant", targets: ["MacAssistant"]),
        .executable(name: "vision-probe", targets: ["VisionProbe"]),
        .executable(name: "ingest-probe", targets: ["IngestProbe"]),
    ],
    targets: [
        .target(name: "CoachWire", path: "Shared/Wire"),
        .target(name: "CoachTransport", dependencies: ["CoachWire"], path: "Shared/Transport"),
        .target(name: "CoachCapture", dependencies: ["CoachWire"], path: "Shared/Capture"),
        .target(name: "CoachSpeech", dependencies: ["CoachWire"], path: "Shared/Speech"),
        .target(name: "CoachAssistantKit", path: "Shared/Assistant"),
        .target(name: "CoachCaptureKit",
                dependencies: ["CoachWire", "CoachTransport", "CoachCapture", "CoachSpeech", "CoachAssistantKit"],
                path: "Shared/CaptureKit"),
        .executableTarget(name: "MacAssistant", dependencies: ["CoachAssistantKit"], path: "MacAssistant/Sources"),
        .executableTarget(name: "VisionProbe", dependencies: ["CoachWire", "CoachCapture"], path: "Tools/VisionProbe"),
        .executableTarget(name: "IngestProbe", dependencies: ["CoachWire", "CoachTransport", "CoachCapture"],
                          path: "Tools/IngestProbe"),
        .testTarget(name: "CoachKitTests",
                    dependencies: ["CoachWire", "CoachTransport", "CoachCapture", "CoachSpeech", "CoachCaptureKit",
                                   "CoachAssistantKit"],
                    path: "Tests/CoachKitTests"),
    ]
)

// iOS capture app entry point. All logic lives in the CoachCaptureKit package product, which also
// compiles on macOS (scripts/apple-check.sh); this target needs Xcode with the iOS SDK.
import CoachCaptureKit
import SwiftUI

@main
struct CaptureIOSApp: App {
    @StateObject private var controller: CaptureController
    /// Created at launch (App.init also runs when HealthKit launches the app in the background to
    /// deliver a mirrored workout), so the mirroring start handler is registered before it is needed.
    private let mirroring: WorkoutMirroringReceiver

    init() {
        let controller = CaptureController()
        _controller = StateObject(wrappedValue: controller)
        mirroring = WorkoutMirroringReceiver(controller: controller)
    }

    var body: some Scene {
        WindowGroup {
            CaptureControlsView(controller: controller)
        }
    }
}

// Receives a workout session that the user explicitly started on the Watch and mirrored to the
// iPhone (HealthKit workout mirroring, iOS 17 / watchOS 10). Samples arrive as WatchLink JSON via
// sendToRemoteWorkoutSession(data:) and are labelled delivery "direct".
// If the app is suspended, HealthKit caches data and delegate calls can be minutes apart; the
// backend judges freshness by each sample's measurement time. The same samples also arrive over
// WatchConnectivity; HeartSampleRelay de-duplicates them (first arrival wins).
// Created in CaptureIOSApp.init so the start handler is set at launch. This app does not request
// HealthKit authorization itself; whether mirroring needs it on the iPhone is not verified on a device.
import CoachCaptureKit
import CoachWire
import HealthKit

final class WorkoutMirroringReceiver: NSObject, HKWorkoutSessionDelegate {
    private let store = HKHealthStore()
    private weak var controller: CaptureController?
    private var mirrored: HKWorkoutSession?

    init(controller: CaptureController) {
        self.controller = controller
        super.init()
        guard HKHealthStore.isHealthDataAvailable() else { return }
        store.workoutSessionMirroringStartHandler = { [weak self] session in
            self?.mirrored = session
            session.delegate = self
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didReceiveDataFromRemoteWorkoutSession data: [Data]) {
        for item in data {
            guard let message = WatchLink.decode([WatchLink.key: item]) else { continue }
            Task { @MainActor [weak self] in self?.controller?.handleMirrored(message) }
        }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                        from fromState: HKWorkoutSessionState, date: Date) {
        if toState == .ended || toState == .stopped { mirrored = nil }
    }

    func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        mirrored = nil
    }
}

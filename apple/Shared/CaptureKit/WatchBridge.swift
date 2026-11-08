import CoachWire
import Foundation
#if canImport(WatchConnectivity) && os(iOS)
import WatchConnectivity
#endif

/// iPhone side of the Watch link. Delivery labels follow the WatchConnectivity path:
/// sendMessage -> live_message, transferUserInfo -> queued_transfer, application context ->
/// application_context. Missing Watch or permission never blocks pose or speech capture.
///
/// WCSession delegate calls arrive on a background queue and mirrored samples on the main actor;
/// `relay` and `state` are guarded by `lock`, and handlers are called outside it.
public final class WatchBridge: NSObject, @unchecked Sendable {
    public typealias SamplesHandler = @Sendable ([HeartRateSamplePayload]) -> Void
    public typealias StatusHandler = @Sendable (CaptureController.WatchState) -> Void

    public let onSamples: SamplesHandler
    public let onStatus: StatusHandler
    /// One id for the paired Watch, stable for this install: "watch-" + the relaying iPhone's id.
    public let watchDeviceId: String
    private var relay = HeartSampleRelay()
    private var state = CaptureController.WatchState()
    private let lock = NSLock()

    public init(relayDeviceId: String, onSamples: @escaping SamplesHandler, onStatus: @escaping StatusHandler) {
        self.watchDeviceId = Self.watchDeviceId(relayDeviceId: relayDeviceId)
        self.onSamples = onSamples
        self.onStatus = onStatus
    }

    public static func watchDeviceId(relayDeviceId: String) -> String { "watch-\(relayDeviceId)" }

    /// Exposed for tests and for the workout-mirroring path ("direct").
    public func handle(_ message: WatchLink.Message, delivery: String) {
        switch message {
        case .heartSamples(let samples):
            lock.lock()
            let payloads = relay.payloads(for: samples, delivery: delivery)
            lock.unlock()
            if !payloads.isEmpty { onSamples(payloads) }
        case .status(let status):
            let snapshot = mutateState {
                $0.authorized = status.authorized
                $0.collectionMode = status.collectionMode
            }
            onStatus(snapshot)
        }
    }

    private func mutateState(_ change: (inout CaptureController.WatchState) -> Void) -> CaptureController.WatchState {
        lock.lock(); defer { lock.unlock() }
        change(&state)
        return state
    }

    #if canImport(WatchConnectivity) && os(iOS)
    public func activate() {
        guard WCSession.isSupported() else { return }
        _ = mutateState { $0.supported = true }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }
    #else
    public func activate() {}
    #endif
}

#if canImport(WatchConnectivity) && os(iOS)
extension WatchBridge: WCSessionDelegate {
    public func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                        error: Error?) {
        refresh(session)
        if !session.receivedApplicationContext.isEmpty, let message = WatchLink.decode(session.receivedApplicationContext) {
            handle(message, delivery: "application_context")
        }
    }

    public func sessionDidBecomeInactive(_ session: WCSession) { refresh(session) }
    public func sessionDidDeactivate(_ session: WCSession) { session.activate() }
    public func sessionReachabilityDidChange(_ session: WCSession) { refresh(session) }
    public func sessionWatchStateDidChange(_ session: WCSession) { refresh(session) }

    public func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        if let decoded = WatchLink.decode(message) { handle(decoded, delivery: "live_message") }
    }

    public func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let decoded = WatchLink.decode(userInfo) { handle(decoded, delivery: "queued_transfer") }
    }

    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        if let decoded = WatchLink.decode(applicationContext) { handle(decoded, delivery: "application_context") }
    }

    private func refresh(_ session: WCSession) {
        let paired = session.isPaired
        let reachable = session.isReachable
        let snapshot = mutateState {
            $0.paired = paired
            $0.reachable = reachable
        }
        onStatus(snapshot)
    }
}
#endif

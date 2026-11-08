import CoachWire
import Foundation
import HealthKit
import WatchConnectivity

/// Heart-rate collection on Apple Watch and transport to the paired iPhone.
///
/// - Passive mode (default): HKAnchoredObjectQuery with an update handler. watchOS decides how often
///   heart rate is measured outside workouts; no public API triggers on-demand measurement, so
///   samples are best effort and labelled passive_healthkit with their real measurement time.
/// - Workout mode: HKWorkoutSession + HKLiveWorkoutBuilder, only when the user explicitly starts it,
///   with a chosen activity type and an explicit save/discard at the end. Workout sessions produce
///   frequent heart-rate samples; no fixed rate is promised. The session is mirrored to the iPhone
///   (watchOS 10) and samples are also sent through WatchConnectivity.
/// - Permissions: read heart rate (HRV only if requested); share workouts only for workout mode.
@MainActor
final class WatchModel: NSObject, ObservableObject {
    enum Activity: String, CaseIterable, Identifiable {
        case mindAndBody, walking, other
        var id: String { rawValue }
        var label: String { self == .mindAndBody ? "Mind & body" : self == .walking ? "Walking" : "Other" }
        var type: HKWorkoutActivityType { self == .mindAndBody ? .mindAndBody : self == .walking ? .walking : .other }
    }

    @Published var authorizationText = "Not requested"
    @Published var passiveRunning = false
    @Published var workoutState = "idle"        // idle | running | stopped
    @Published var activity: Activity = .mindAndBody
    @Published var reachable = false
    @Published var lastBPM: Double?
    @Published var lastAge: TimeInterval = 0
    @Published var error: String?

    private let store = HKHealthStore()
    private let heartRate = HKQuantityType(.heartRate)
    private var anchor: HKQueryAnchor?
    private var passiveQuery: HKAnchoredObjectQuery?
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var outbox = WatchOutbox(capacity: 60)
    private var hrvRequested = false

    override init() {
        super.init()
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    // MARK: authorization

    func authorize(includeHRV: Bool) async {
        guard HKHealthStore.isHealthDataAvailable() else { authorizationText = "Health data unavailable"; return }
        var read: Set<HKObjectType> = [heartRate]
        if includeHRV { read.insert(HKQuantityType(.heartRateVariabilitySDNN)); hrvRequested = true }
        do {
            try await store.requestAuthorization(toShare: [], read: read)
            // Read authorization status is not revealed by HealthKit; absence of samples is reported instead.
            authorizationText = "Requested (HealthKit does not reveal read permission; missing data is reported)"
            send(.status(.init(authorized: nil, collectionMode: passiveRunning ? "passive_healthkit" : "off",
                               workoutActive: workoutState == "running")))
        } catch {
            authorizationText = "Authorization failed: \(error.localizedDescription)"
        }
    }

    // MARK: passive

    func startPassive() {
        let predicate = HKQuery.predicateForSamples(withStart: Date().addingTimeInterval(-60), end: nil)
        let query = HKAnchoredObjectQuery(type: heartRate, predicate: predicate, anchor: anchor,
                                          limit: HKObjectQueryNoLimit) { [weak self] _, samples, _, newAnchor, error in
            Task { @MainActor in self?.receive(samples, anchor: newAnchor, mode: "passive_healthkit", error: error) }
        }
        query.updateHandler = { [weak self] _, samples, _, newAnchor, error in
            Task { @MainActor in self?.receive(samples, anchor: newAnchor, mode: "passive_healthkit", error: error) }
        }
        store.execute(query)
        passiveQuery = query
        passiveRunning = true
    }

    func stopPassive() {
        if let passiveQuery { store.stop(passiveQuery) }
        passiveQuery = nil
        passiveRunning = false
    }

    private func receive(_ samples: [HKSample]?, anchor newAnchor: HKQueryAnchor?, mode: String, error: Error?) {
        if let error { self.error = error.localizedDescription; return }
        anchor = newAnchor
        let unit = HKUnit.count().unitDivided(by: .minute())
        for case let sample as HKQuantitySample in samples ?? [] {
            route(WatchLink.HeartSample(bpm: sample.quantity.doubleValue(for: unit), measuredAt: sample.endDate,
                                        collectionMode: mode, sampleUUID: sample.uuid.uuidString))
        }
    }

    // MARK: explicit workout

    func startWorkout() async {
        do {
            try await store.requestAuthorization(toShare: [HKObjectType.workoutType()], read: [heartRate])
            let configuration = HKWorkoutConfiguration()
            configuration.activityType = activity.type
            configuration.locationType = .indoor
            let session = try HKWorkoutSession(healthStore: store, configuration: configuration)
            let builder = session.associatedWorkoutBuilder()
            builder.dataSource = HKLiveWorkoutDataSource(healthStore: store, workoutConfiguration: configuration)
            builder.delegate = self
            session.delegate = self
            self.session = session
            self.builder = builder
            let start = Date()
            session.startActivity(with: start)
            try await builder.beginCollection(at: start)
            try? await session.startMirroringToCompanionDevice()
            workoutState = "running"
            send(.status(.init(authorized: nil, collectionMode: "workout_session", workoutActive: true)))
        } catch {
            self.error = "Workout could not start: \(error.localizedDescription)"
        }
    }

    func stopWorkout() {
        session?.end()
        workoutState = "stopped"
    }

    func finishWorkout(save: Bool) {
        guard let builder else { workoutState = "idle"; return }
        Task {
            do {
                try await builder.endCollection(at: Date())
                if save { _ = try await builder.finishWorkout() } else { builder.discardWorkout() }
            } catch {
                self.error = "Finishing the workout failed: \(error.localizedDescription)"
            }
            self.session = nil
            self.builder = nil
            self.workoutState = "idle"
            self.send(.status(.init(authorized: nil, collectionMode: self.passiveRunning ? "passive_healthkit" : "off",
                                    workoutActive: false)))
        }
    }

    // MARK: transport

    private func route(_ sample: WatchLink.HeartSample) {
        lastBPM = sample.bpm
        lastAge = Date().timeIntervalSince(sample.measuredAt)
        let reachableNow = WCSession.default.activationState == .activated && WCSession.default.isReachable
        reachable = reachableNow
        switch outbox.route(sample, reachable: reachableNow) {
        case .live(let current, let backlog):
            if let payload = try? WatchLink.encode(.heartSamples([current])) {
                WCSession.default.sendMessage(payload, replyHandler: nil) { [weak self] error in
                    Task { @MainActor in self?.error = "Live message failed: \(error.localizedDescription)" }
                }
            }
            if !backlog.isEmpty, let payload = try? WatchLink.encode(.heartSamples(backlog)) {
                WCSession.default.transferUserInfo(payload)     // labelled queued_transfer on the iPhone
            }
        case .deferred(let latest):
            if let payload = try? WatchLink.encode(.heartSamples([latest])) {
                try? WCSession.default.updateApplicationContext(payload)   // latest state only
            }
        }
        if let session, let data = try? WatchLink.encode(.heartSamples([sample]))[WatchLink.key] as? Data {
            Task { try? await session.sendToRemoteWorkoutSession(data: data) }
        }
    }

    private func send(_ message: WatchLink.Message) {
        guard let payload = try? WatchLink.encode(message), WCSession.default.activationState == .activated else { return }
        if WCSession.default.isReachable {
            WCSession.default.sendMessage(payload, replyHandler: nil, errorHandler: nil)
        } else {
            try? WCSession.default.updateApplicationContext(payload)
        }
    }
}

extension WatchModel: HKLiveWorkoutBuilderDelegate, HKWorkoutSessionDelegate, WCSessionDelegate {
    nonisolated func workoutBuilder(_ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>) {
        guard collectedTypes.contains(HKQuantityType(.heartRate)),
              let statistics = workoutBuilder.statistics(for: HKQuantityType(.heartRate)),
              let quantity = statistics.mostRecentQuantity() else { return }
        let bpm = quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
        let measured = statistics.mostRecentQuantityDateInterval()?.end ?? Date()
        Task { @MainActor in
            self.route(WatchLink.HeartSample(bpm: bpm, measuredAt: measured, collectionMode: "workout_session", sampleUUID: nil))
        }
    }

    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didChangeTo toState: HKWorkoutSessionState,
                                    from fromState: HKWorkoutSessionState, date: Date) {}

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in self.error = "Workout session failed: \(error.localizedDescription)" }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState,
                             error: Error?) {
        Task { @MainActor in self.reachable = session.isReachable }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor in self.reachable = session.isReachable }
    }
}

import CoachCaptureKit
import CoachSpeech
import CoachTransport
import CoachWire
import Foundation
import Testing
#if canImport(Vision)
import CoachCapture
#endif

@Test func clockSampleMatchesBackendFormula() {
    let sample = ClockSample(t0: 1000, t1: 755, t2: 755, t3: 1010)!
    #expect(sample.offsetMs == -250 && sample.rttMs == 10)
    #expect(ClockSample(t0: 1000, t1: 900, t2: 800, t3: 1010) == nil)          // t2 < t1 is inconsistent
    let best = ClockSample.best([sample, ClockSample(t0: 0, t1: 50, t2: 50, t3: 30)!])
    #expect(best?.rttMs == 10)
}

@Test func energyVADCalibratesAndUsesHysteresis() {
    var vad = EnergyVAD()
    let t0 = Date(timeIntervalSince1970: 1_800_000_000)
    var transitions: [(SpeechActivityPayload, Date)] = []
    var t = 0.0
    func feed(_ level: Float, seconds: Double) {
        let step = 0.02
        for _ in 0..<Int(seconds / step) {
            transitions += vad.process(levelDb: level, duration: step, at: t0.addingTimeInterval(t))
            t += step
        }
    }
    feed(-60, seconds: 1.6)                       // calibration: quiet room
    #expect(vad.calibrated && vad.thresholdDb == -50)
    feed(-30, seconds: 0.1)                       // too short to count as speech
    #expect(transitions.isEmpty)
    feed(-60, seconds: 0.5)
    feed(-30, seconds: 1.0)                       // speech
    feed(-52, seconds: 0.2)                       // brief dip within release band: still speech
    feed(-30, seconds: 0.5)
    feed(-60, seconds: 1.0)                       // silence -> end after hangover
    #expect(transitions.map { $0.0.transition } == ["speech_start", "speech_end"])
    let start = transitions[0].1.timeIntervalSince(t0)
    #expect(abs(start - 2.2) < 0.03)               // backdated to when the loud run began
    #expect(transitions[0].0.vadMethod == EnergyVAD.method && transitions[0].0.calibrated)
}

@Test func heartRelayDeduplicatesAndKeepsDeliveryLabels() {
    var relay = HeartSampleRelay()
    let now = Date(timeIntervalSince1970: 1_800_000_100)
    let old = WatchLink.HeartSample(bpm: 80, measuredAt: now.addingTimeInterval(-90), collectionMode: "passive_healthkit",
                                    sampleUUID: "A")
    let queued = relay.payloads(for: [old], delivery: "queued_transfer", now: now)
    #expect(queued.count == 1 && queued[0].delivery == "queued_transfer" && queued[0].sampleAgeMsAtSend == 90_000)
    #expect(relay.payloads(for: [old], delivery: "live_message", now: now).isEmpty)   // duplicate UUID
}

@Test func watchOutboxNeverSendsBacklogAsLive() {
    var outbox = WatchOutbox(capacity: 3)
    let samples = (0..<5).map { WatchLink.HeartSample(bpm: Double(70 + $0), measuredAt: Date(), collectionMode: "workout_session",
                                                      sampleUUID: "\($0)") }
    for sample in samples.prefix(4) {
        guard case .deferred = outbox.route(sample, reachable: false) else { Issue.record("expected deferred"); return }
    }
    #expect(outbox.backlog.count == 3 && outbox.dropped == 1)                  // bounded
    guard case .live(let current, let backlog) = outbox.route(samples[4], reachable: true) else {
        Issue.record("expected live"); return
    }
    #expect(current.sampleUUID == "4" && backlog.map(\.sampleUUID) == ["1", "2", "3"] && outbox.backlog.isEmpty)
}

@Test func watchLinkRoundTripAndBridgeLabels() throws {
    // Fixed dates: millisecondsSince1970 round-trips of arbitrary Date() values can differ by one ulp.
    let sample = WatchLink.HeartSample(bpm: 77, measuredAt: Date(timeIntervalSince1970: 1_800_000_000), collectionMode: "workout_session",
                                       sampleUUID: "U1", sentAt: Date(timeIntervalSince1970: 1_800_000_001))
    let dictionary = try WatchLink.encode(.heartSamples([sample]))
    #expect(WatchLink.decode(dictionary) == .heartSamples([sample]))
    let received = Locked<[HeartRateSamplePayload]>([])
    let bridge = WatchBridge(relayDeviceId: "iphone-1", onSamples: { payloads in received.mutate { $0 += payloads } },
                             onStatus: { _ in })
    bridge.handle(.heartSamples([sample]), delivery: "application_context")
    let first = received.value.first
    #expect(first?.delivery == "application_context" && first?.collectionMode == "workout_session")
    #expect(bridge.watchDeviceId == "watch-iphone-1" && WatchBridge.watchDeviceId(relayDeviceId: "iphone-1") == bridge.watchDeviceId)
}

#if canImport(Vision)
@Test func jointMappingIsCompleteAndFlipsY() {
    #expect(PoseJoints.names2D.count == 19 && Set(PoseJoints.names2D.map(\.1)).count == 19)
    #expect(PoseJoints.names3D.count == 17 && Set(PoseJoints.names3D.map(\.1)).count == 17)
    let point = PoseJoints.topLeft(x: 0.25, y: 0.9)
    #expect(point.x == 0.25 && abs(point.y - 0.1) < 1e-12)
}
#endif

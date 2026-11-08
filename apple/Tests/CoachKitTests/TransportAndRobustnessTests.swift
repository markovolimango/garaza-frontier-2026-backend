import CoachAssistantKit
import CoachSpeech
@testable import CoachTransport
@testable import CoachWire
import Foundation
import Testing

/// Thread-safe box for values written from @Sendable callbacks in tests.
final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value { lock.lock(); defer { lock.unlock() }; return stored }
    func mutate(_ change: (inout Value) -> Void) { lock.lock(); defer { lock.unlock() }; change(&stored) }
}

private let source = SourceInfo(deviceId: "iphone-1", kind: "iphone")
private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

private func transcript(_ text: String) -> OutgoingEvent {
    OutgoingEvent(sessionId: "", source: source, eventType: .transcriptPartial, capturedAt: t0,
                  payload: .transcript(TranscriptPayload(utteranceId: "utt-1", revision: 1, text: text, language: "en-US",
                                                         onDevice: true, audioStartAt: t0, segments: nil)))
}

private func status() -> OutgoingEvent {
    OutgoingEvent(sessionId: "", source: source, eventType: .deviceStatus, capturedAt: t0,
                  payload: .deviceStatus(DeviceStatusPayload(status: "heartbeat")))
}

private func decodeBatch(_ data: Data) throws -> [[String: Any]] {
    let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    #expect(object["type"] as? String == "events")
    return try #require(object["events"] as? [[String: Any]])
}

@Test func batchesStayUnderTheByteLimitWithoutSequenceGaps() throws {
    var queue = OutboundQueue(limits: .init(batchSize: 50, maxBatchBytes: 4096))
    let sequences = SequenceAllocator()
    for _ in 0..<30 { queue.enqueue(transcript(String(repeating: "word ", count: 120))) }   // ~0.9 KB each
    var sent: [[String: Any]] = []
    var batches = 0
    while let batch = queue.nextBatch(sessionId: "ses_1", backpressure: false, sequences: sequences) {
        #expect(batch.data.count <= 4096)
        let events = try decodeBatch(batch.data)
        #expect(events.count == batch.events.count && events.count < 30)
        sent += events
        batches += 1
    }
    #expect(sent.count == 30 && batches > 1)
    #expect(sent.compactMap { $0["sequence"] as? Int } == Array(0..<30))
    #expect(sent.allSatisfy { $0["session_id"] as? String == "ses_1" })
    #expect(queue.unackedIds.count == 30 && queue.counters == .init())
}

@Test func oversizeAndUnencodableEventsAreDroppedNotResent() throws {
    var queue = OutboundQueue(limits: .init(maxBatchBytes: 4096))
    let sequences = SequenceAllocator()
    queue.enqueue(transcript(String(repeating: "x", count: 10_000)))            // alone larger than the limit
    var bad = SpeechActivityPayload(transition: "speech_start", vadMethod: EnergyVAD.method, levelDbfs: nil,
                                    thresholdDbfs: nil, noiseFloorDbfs: nil, calibrated: true)
    bad.levelDbfs = .nan                                                         // JSONEncoder refuses NaN
    queue.enqueue(OutgoingEvent(sessionId: "", source: source, eventType: .speechActivity, capturedAt: t0,
                                payload: .speechActivity(bad)))
    queue.enqueue(status())
    let next = queue.nextBatch(sessionId: "ses_1", backpressure: false, sequences: sequences)
    let batch = try #require(next)
    let events = try decodeBatch(batch.data)
    #expect(events.count == 1 && events[0]["event_type"] as? String == "device.status")
    #expect(events[0]["sequence"] as? Int == 0)                                  // dropped events used no number
    #expect(queue.counters.droppedOversize == 1 && queue.counters.droppedUnencodable == 1)
    #expect(queue.unackedIds == [batch.events[0].eventId])
    queue.requeueForReconnect()                                                  // only the good event is re-sent
    #expect(queue.high.map(\.eventId) == [batch.events[0].eventId])
}

@Test func retryableRejectionsAreResentOnTheLiveConnection() throws {
    var queue = OutboundQueue(limits: .init(retryDelay: 1))
    let sequences = SequenceAllocator()
    queue.enqueue(status())
    let firstBatch = queue.nextBatch(sessionId: "ses_1", backpressure: false, sequences: sequences)
    let first = try #require(firstBatch).events[0]
    let summary = queue.acknowledge([AckResult(eventId: first.eventId, status: "rejected", code: "queue_full",
                                               message: nil, retryable: true)], now: 100)
    #expect(summary.retrying == 1 && summary.rejected == 0 && queue.pendingHigh == 1 && queue.counters.retried == 1)
    queue.releaseDueRetries(now: 100.5)
    let early = queue.nextBatch(sessionId: "ses_1", backpressure: false, sequences: sequences)
    #expect(early == nil)
    queue.releaseDueRetries(now: 101.1)
    let retried = queue.nextBatch(sessionId: "ses_1", backpressure: false, sequences: sequences)
    let again = try #require(retried).events
    #expect(again.map(\.eventId) == [first.eventId] && again[0].sequence == first.sequence)
    let final = queue.acknowledge([AckResult(eventId: first.eventId, status: "accepted", code: nil, message: nil,
                                             retryable: nil)], now: 102)
    #expect(final.accepted == 1 && queue.pendingHigh == 0)
}

@Test func droppedHighCountsOnlyRemovedEvents() throws {
    var queue = OutboundQueue(limits: .init(maxPendingHigh: 3))
    let sequences = SequenceAllocator()
    for _ in 0..<3 { queue.enqueue(status()) }
    let batch = queue.nextBatch(sessionId: "ses_1", backpressure: false, sequences: sequences)   // 3 unacked
    #expect(batch?.events.count == 3)
    queue.enqueue(status())
    queue.enqueue(status())
    #expect(queue.counters.droppedHigh == 2 && queue.pendingHigh == 3)
}

@Test func joinIsResentUntilALiveSessionExists() {
    #expect(JoinPolicy.needsSession(nil, pinned: nil))
    let running = SessionControl(sessionId: "ses_1", state: "running", micSource: "iphone", simulated: false,
                                 timeline: "live", language: "en-US", poseRateHz: 12)
    var ended = running
    ended.state = "ended"
    #expect(!JoinPolicy.needsSession(running, pinned: nil))
    #expect(JoinPolicy.needsSession(ended, pinned: nil))
    #expect(!JoinPolicy.needsSession(ended, pinned: "ses_1"))                    // a pinned session is not replaced
    var policy = JoinPolicy(pinnedSessionId: nil, interval: 2)
    policy.markSent(now: 10)                                                     // initial join on the new socket
    var decisions: [Bool] = []
    for (session, now) in [(nil, 11.0), (nil, 12.1), (nil, 13), (running, 20), (ended, 20)] as [(SessionControl?, Double)] {
        decisions.append(policy.shouldSend(session: session, now: now))
    }
    #expect(decisions == [false, true, false, false, true])
}

@Test func backoffGrowsCapsAndResets() {
    var backoff = Backoff(initial: 0.5, maximum: 10)
    var delays: [Double] = []
    for _ in 0..<7 { delays.append(backoff.next()) }
    #expect(delays == [0.5, 1, 2, 4, 8, 10, 10])
    backoff.reset()
    let afterReset = backoff.next()
    #expect(afterReset == 0.5)
}

@Test func sequenceNumbersStayMonotonicAcrossConnectionsAndRestarts() throws {
    let suite = "coach.tests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let first = SequenceAllocator(defaults: defaults)
    for n in 0..<5 { first.commit("iphone-1", n) }
    first.flush()
    #expect(SequenceAllocator(defaults: defaults).peek("iphone-1") == 5)        // clean stop: exact
    let second = SequenceAllocator(defaults: defaults)
    for n in 5..<45 { second.commit("iphone-1", n) }                            // saved at 32 commits, not flushed
    #expect(SequenceAllocator(defaults: defaults).peek("iphone-1") >= 45)       // crash: never reuses a number
}

@Test func levelDbfsIsClampedToFullScale() {
    let loud: [Float] = Array(repeating: 2.0, count: 256)                       // RMS 2 = +6 dBFS
    #expect(loud.withUnsafeBufferPointer { EnergyVAD.levelDbfs($0) } == 0)
    let silent: [Float] = Array(repeating: 0, count: 256)
    #expect(silent.withUnsafeBufferPointer { EnergyVAD.levelDbfs($0) } == -100)
    var vad = EnergyVAD()
    var transitions: [(SpeechActivityPayload, Date)] = []
    for step in 0..<200 {
        transitions += vad.process(levelDb: step < 80 ? -60 : 6, duration: 0.02, at: t0.addingTimeInterval(Double(step) * 0.02))
    }
    #expect(transitions.count == 1 && (transitions[0].0.levelDbfs ?? 1) <= 0)
}

@Test func workoutSamplesWithoutUUIDAreDeduplicatedAcrossPaths() {
    var relay = HeartSampleRelay()
    let measured = Date(timeIntervalSince1970: 1_800_000_000.123)
    let sample = WatchLink.HeartSample(bpm: 92, measuredAt: measured, collectionMode: "workout_session", sampleUUID: nil)
    let live = relay.payloads(for: [sample], delivery: "live_message", now: measured)
    let mirrored = relay.payloads(for: [sample], delivery: "direct", now: measured)        // same sample, second path
    let next = WatchLink.HeartSample(bpm: 93, measuredAt: measured, collectionMode: "workout_session", sampleUUID: nil)
    let later = relay.payloads(for: [next], delivery: "direct", now: measured)
    #expect(live.count == 1 && live[0].delivery == "live_message" && mirrored.isEmpty && later.count == 1)
}

@Test func httpParserRejectsMalformedRequestsBeforeRangeMath() {
    func parse(_ text: String) -> HTTPRequest.Parse { HTTPRequest.parse(Data(text.utf8)) }
    func status(_ result: HTTPRequest.Parse) -> Int? {
        if case .invalid(let status, _) = result { return status }
        return nil
    }
    #expect(status(parse("GET /v1/status HTTP/1.1\r\nContent-Length: -5\r\n\r\n")) == 400)
    #expect(status(parse("GET /v1/status HTTP/1.1\r\nContent-Length: +5\r\n\r\n")) == 400)
    #expect(status(parse("POST /v1/tts/speak HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n")) == 413)
    #expect(status(parse("POST / HTTP/1.1\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n")) == 400)
    #expect(status(parse("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n")) == 501)
    #expect(status(parse("garbage\r\n\r\n")) == 400)
    #expect(status(parse("GET / HTTP/1.1\r\nno colon here\r\n\r\n")) == 400)
    #expect(status(HTTPRequest.parse(Data(repeating: 65, count: HTTPRequest.maxHeaderBytes + 1))) == 431)
    guard case .incomplete = parse("POST /v1/fm/rephrase HTTP/1.1\r\nContent-Length: 10\r\n\r\n{\"a\"") else {
        Issue.record("expected incomplete"); return
    }
    guard case .complete(let request) = parse("POST /v1/fm/rephrase?x=1 HTTP/1.1\r\nAuthorization: Bearer t\r\nContent-Length: 7\r\n\r\n{\"a\":1}") else {
        Issue.record("expected complete"); return
    }
    #expect(request.method == "POST" && request.path == "/v1/fm/rephrase" && request.headers["authorization"] == "Bearer t")
    #expect(request.json?["a"] as? Int == 1)
}

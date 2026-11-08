import CoachWire
import Foundation

/// Per-source sequence numbers that stay monotonic across connections (a new `CoachConnection` per
/// Connected toggle) and, with `defaults`, across app restarts. The backend flags a sequence that
/// goes backwards as out of order for the rest of the session, so numbers are never reused.
public final class SequenceAllocator: @unchecked Sendable {   // mutable state guarded by `lock`
    private let lock = NSLock()
    private var nextBySource: [String: Int]
    private let defaults: UserDefaults?
    private let key: String
    private var unsaved = 0
    static let saveEvery = 32

    public init(defaults: UserDefaults? = nil, key: String = "coach.sequences") {
        self.defaults = defaults
        self.key = key
        let stored = defaults?.dictionary(forKey: key)
        let saved = stored?["next"] as? [String: Int] ?? [:]
        // Up to saveEvery - 1 numbers may have been used after the last save if the app did not flush.
        let margin = (stored?["clean"] as? Bool ?? true) ? 0 : Self.saveEvery
        nextBySource = saved.mapValues { $0 + margin }
    }

    /// The next number for `source`, without using it.
    public func peek(_ source: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        return nextBySource[source, default: 0]
    }

    /// Marks `used` as transmitted; later numbers for `source` are greater.
    public func commit(_ source: String, _ used: Int) {
        lock.lock(); defer { lock.unlock() }
        nextBySource[source] = max(nextBySource[source, default: 0], used + 1)
        unsaved += 1
        if unsaved >= Self.saveEvery { saveLocked(clean: false) }
    }

    /// Persists the exact counters (call when a connection stops).
    public func flush() {
        lock.lock(); defer { lock.unlock() }
        saveLocked(clean: true)
    }

    private func saveLocked(clean: Bool) {
        unsaved = 0
        defaults?.set(["next": nextBySource, "clean": clean] as [String: Any], forKey: key)
    }
}

/// When to (re)send `join`: on every new socket, then every `interval` seconds until the server
/// answers with a session that has not ended. A pinned session id is never replaced once it ended.
public struct JoinPolicy: Sendable {
    public let pinnedSessionId: String?
    public let interval: TimeInterval
    public private(set) var lastSentAt: TimeInterval?

    public init(pinnedSessionId: String?, interval: TimeInterval = 2) {
        self.pinnedSessionId = pinnedSessionId
        self.interval = interval
    }

    /// True while the device has no usable session: none known yet, or the joined one ended.
    public static func needsSession(_ session: SessionControl?, pinned: String?) -> Bool {
        guard let session else { return true }
        return session.state == "ended" && pinned == nil
    }

    /// Returns true (and records the send) when a join should go out now.
    public mutating func shouldSend(session: SessionControl?, now: TimeInterval) -> Bool {
        guard Self.needsSession(session, pinned: pinnedSessionId) else { return false }
        if let last = lastSentAt, now - last < interval { return false }
        lastSentAt = now
        return true
    }

    public mutating func markSent(now: TimeInterval) { lastSentAt = now }
}

/// Outgoing event queues of one device (pure state; `CoachConnection` owns one).
///
/// - Pose frames: bounded, oldest dropped; discarded after a reconnect.
/// - High priority (control, speech, heart rate): kept until acknowledged and re-sent after a
///   reconnect (the server de-duplicates by event_id). A retryable rejection (`queue_full`) is
///   re-sent on the live connection after `retryDelay`.
/// - Batches are limited by event count and by encoded bytes (below the server's
///   max_message_bytes). Events are encoded before they become "unacknowledged"; an event that
///   cannot be encoded, or that alone exceeds the byte limit, is dropped and counted instead of
///   blocking the queue or being re-sent forever.
struct OutboundQueue: Sendable {
    struct Limits: Sendable {
        var maxPoseQueue = 15
        var maxPendingHigh = 500
        var batchSize = 50
        var maxBatchBytes = 192 * 1024
        var retryDelay: TimeInterval = 1.0
    }

    struct Counters: Equatable, Sendable {
        var droppedPose = 0
        var droppedHigh = 0
        var droppedOversize = 0
        var droppedUnencodable = 0
        var retried = 0
    }

    struct AckSummary: Equatable, Sendable {
        var accepted = 0
        var duplicates = 0
        var rejected = 0
        var retrying = 0
        var lastRejection: String?
    }

    struct Batch {
        let data: Data
        let events: [OutgoingEvent]
    }

    private enum Lane { case high, pose }

    /// `{"events":[` + `],"type":"events"}` (keys sorted like WireCoding's encoder).
    static let prefix = Data(#"{"events":["#.utf8)
    static let suffix = Data(#"],"type":"events"}"#.utf8)

    let limits: Limits
    private(set) var pose: [OutgoingEvent] = []
    private(set) var high: [OutgoingEvent] = []
    private var unacked: [String: OutgoingEvent] = [:]
    private var unackedOrder: [String] = []
    private var retry: [(due: TimeInterval, event: OutgoingEvent)] = []
    private(set) var counters = Counters()

    init(limits: Limits = Limits()) { self.limits = limits }

    var pendingHigh: Int { high.count + unacked.count + retry.count }
    var unackedIds: [String] { unackedOrder }

    mutating func enqueue(_ event: OutgoingEvent) {
        if event.eventType.isHighPriority {
            high.append(event)
            let overflow = pendingHigh - limits.maxPendingHigh
            if overflow > 0 {
                let removed = min(overflow, high.count)
                high.removeFirst(removed)
                counters.droppedHigh += removed
            }
        } else {
            pose.append(event)
            if pose.count > limits.maxPoseQueue {
                let overflow = pose.count - limits.maxPoseQueue
                pose.removeFirst(overflow)
                counters.droppedPose += overflow
            }
        }
    }

    /// New socket: unacknowledged and retry-pending events go first; stale pose frames are dropped.
    mutating func requeueForReconnect() {
        high = unackedOrder.compactMap { unacked[$0] } + retry.map(\.event) + high
        unacked.removeAll()
        unackedOrder.removeAll()
        retry.removeAll()
        counters.droppedPose += pose.count
        pose.removeAll()
    }

    /// Moves retryable rejections whose delay has passed back to the front of the high lane.
    mutating func releaseDueRetries(now: TimeInterval) {
        guard retry.contains(where: { $0.due <= now }) else { return }
        let due = retry.filter { $0.due <= now }.map(\.event)
        retry.removeAll { $0.due <= now }
        high = due + high
    }

    mutating func acknowledge(_ results: [AckResult], now: TimeInterval) -> AckSummary {
        var summary = AckSummary()
        for result in results {
            switch result.status {
            case "accepted":
                summary.accepted += 1
                if let id = result.eventId { forget(id) }
            case "duplicate":
                summary.duplicates += 1
                if let id = result.eventId { forget(id) }
            default:
                if result.retryable == true, let id = result.eventId, let event = unacked[id] {
                    forget(id)
                    retry.append((now + limits.retryDelay, event))
                    summary.retrying += 1
                    counters.retried += 1
                } else {
                    summary.rejected += 1
                    summary.lastRejection = "\(result.code ?? "rejected"): \(result.message ?? "")"
                    if let id = result.eventId { forget(id) }
                }
            }
        }
        return summary
    }

    /// Takes the next batch (high lane first). Assigns the session id and per-source sequence
    /// numbers, encodes each event once and records high-priority events as unacknowledged.
    mutating func nextBatch(sessionId: String, backpressure: Bool, sequences: SequenceAllocator,
                            encoder: JSONEncoder = WireCoding.makeEncoder()) -> Batch? {
        if backpressure, pose.count > 1 {
            counters.droppedPose += pose.count - 1
            pose.removeFirst(pose.count - 1)
        }
        let overhead = Self.prefix.count + Self.suffix.count
        var parts: [Data] = []
        var events: [OutgoingEvent] = []
        var bytes = overhead
        var full = false
        for lane in [Lane.high, .pose] where !full {
            while events.count < limits.batchSize {
                guard var event = (lane == .high ? high.first : pose.first) else { break }
                if event.sessionId.isEmpty { event.sessionId = sessionId }
                let source = event.source.deviceId
                var reserved: Int?
                if event.sequence == nil {
                    reserved = sequences.peek(source)
                    event.sequence = reserved
                }
                guard let data = try? encoder.encode(event) else {
                    removeFirst(lane)
                    counters.droppedUnencodable += 1
                    continue
                }
                if overhead + data.count > limits.maxBatchBytes {   // could never be sent
                    removeFirst(lane)
                    counters.droppedOversize += 1
                    continue
                }
                let added = data.count + (parts.isEmpty ? 0 : 1)
                if bytes + added > limits.maxBatchBytes {
                    full = true
                    break
                }
                removeFirst(lane)
                if let reserved { sequences.commit(source, reserved) }
                parts.append(data)
                events.append(event)
                bytes += added
                if event.eventType.isHighPriority {
                    unacked[event.eventId] = event
                    unackedOrder.append(event.eventId)
                }
            }
        }
        guard !parts.isEmpty else { return nil }
        var data = Self.prefix
        data.reserveCapacity(bytes)
        for (index, part) in parts.enumerated() {
            if index > 0 { data.append(UInt8(ascii: ",")) }
            data.append(part)
        }
        data.append(Self.suffix)
        return Batch(data: data, events: events)
    }

    private mutating func removeFirst(_ lane: Lane) {
        switch lane {
        case .high: high.removeFirst()
        case .pose: pose.removeFirst()
        }
    }

    private mutating func forget(_ id: String) {
        if unacked.removeValue(forKey: id) != nil {
            unackedOrder.removeAll { $0 == id }
        }
    }
}

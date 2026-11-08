import Foundation

/// Messages from the Watch app to its paired iPhone (WatchConnectivity), JSON-encoded under one key.
public enum WatchLink {
    public static let key = "coach"

    public struct HeartSample: Codable, Equatable, Sendable {
        public var bpm: Double
        public var measuredAt: Date              // HKSample end date, Watch clock
        public var collectionMode: String        // passive_healthkit | workout_session
        public var sampleUUID: String?
        public var hrvSDNNms: Double?
        public var sentAt: Date
        public init(bpm: Double, measuredAt: Date, collectionMode: String, sampleUUID: String?,
                    hrvSDNNms: Double? = nil, sentAt: Date = Date()) {
            self.bpm = bpm; self.measuredAt = measuredAt; self.collectionMode = collectionMode
            self.sampleUUID = sampleUUID; self.hrvSDNNms = hrvSDNNms; self.sentAt = sentAt
        }
    }

    public struct Status: Codable, Equatable, Sendable {
        public var authorized: Bool?
        public var collectionMode: String        // passive_healthkit | workout_session | off
        public var workoutActive: Bool
        public var reason: String?
        public init(authorized: Bool?, collectionMode: String, workoutActive: Bool, reason: String? = nil) {
            self.authorized = authorized; self.collectionMode = collectionMode
            self.workoutActive = workoutActive; self.reason = reason
        }
    }

    public enum Message: Codable, Equatable, Sendable {
        case heartSamples([HeartSample])
        case status(Status)
    }

    public static func encode(_ message: Message) throws -> [String: Any] {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return [key: try encoder.encode(message)]
    }

    public static func decode(_ dictionary: [String: Any]) -> Message? {
        guard let data = dictionary[key] as? Data else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970
        return try? decoder.decode(Message.self, from: data)
    }
}

/// iPhone side: turns Watch samples into heart_rate.sample payloads with honest delivery labels.
/// A sample delivered through queued transfer or application context keeps that label and its
/// real measurement time, so the backend can tell it apart from live data.
///
/// De-duplication: the same sample can arrive on several paths (live message, queued transfer,
/// application context, workout mirroring). Samples are keyed by their HealthKit UUID, or, for
/// workout-builder statistics that have no UUID, by measurement time (ms) and bpm. The first
/// arrival wins and keeps its delivery label.
public struct HeartSampleRelay: Sendable {
    public private(set) var seen: [String] = []
    private var seenSet: Set<String> = []
    private let maxSeen: Int
    public init(maxSeen: Int = 512) { self.maxSeen = maxSeen }

    public static func key(_ sample: WatchLink.HeartSample) -> String {
        if let id = sample.sampleUUID { return id }
        let ms = Int64((sample.measuredAt.timeIntervalSince1970 * 1000).rounded())
        return "t\(ms)-\(sample.bpm)"
    }

    /// delivery: live_message | queued_transfer | application_context | direct
    public mutating func payloads(for samples: [WatchLink.HeartSample], delivery: String,
                                  now: Date = Date()) -> [HeartRateSamplePayload] {
        var out: [HeartRateSamplePayload] = []
        for sample in samples {
            let key = Self.key(sample)
            if seenSet.contains(key) { continue }
            seen.append(key)
            seenSet.insert(key)
            if seen.count > maxSeen {
                let expired = seen.prefix(seen.count - maxSeen)
                expired.forEach { seenSet.remove($0) }
                seen.removeFirst(expired.count)
            }
            out.append(HeartRateSamplePayload(
                bpm: sample.bpm, measuredAt: sample.measuredAt,
                sampleAgeMsAtSend: max(0, now.timeIntervalSince(sample.measuredAt) * 1000),
                collectionMode: sample.collectionMode, delivery: delivery, availability: "available",
                hkSampleUUID: sample.sampleUUID, hrvSDNNms: sample.hrvSDNNms))
        }
        return out
    }
}

/// Watch side: bounded buffering while the iPhone is unreachable.
/// Live messages are only sent while reachable. Otherwise only the latest sample goes into the
/// application context (latest state), and a small bounded backlog may be queued; both are
/// labelled as delayed deliveries on the iPhone, never as live.
public struct WatchOutbox: Sendable {
    public private(set) var backlog: [WatchLink.HeartSample] = []
    public private(set) var dropped = 0
    public let capacity: Int
    public init(capacity: Int = 60) { self.capacity = capacity }

    public enum Route: Equatable, Sendable {
        /// Send `current` as a live message; send `backlog` separately as a queued transfer.
        case live(current: WatchLink.HeartSample, backlog: [WatchLink.HeartSample])
        /// Unreachable: update the application context with the latest sample only.
        case deferred(latest: WatchLink.HeartSample)
    }

    public mutating func route(_ sample: WatchLink.HeartSample, reachable: Bool) -> Route {
        if reachable {
            let pending = backlog
            backlog.removeAll()
            return .live(current: sample, backlog: pending)
        }
        backlog.append(sample)
        if backlog.count > capacity {
            dropped += backlog.count - capacity
            backlog.removeFirst(backlog.count - capacity)
        }
        return .deferred(latest: sample)
    }
}

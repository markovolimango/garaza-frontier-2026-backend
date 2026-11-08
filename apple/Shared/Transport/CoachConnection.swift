import CoachWire
import Foundation

public struct ConnectionStats: Equatable, Sendable {
    public var state = "idle"
    public var lastError: String?
    public var sessionId: String?
    public var sessionState: String?
    public var clockOffsetMs: Double?
    public var clockUncertaintyMs: Double?
    public var sent = 0
    public var accepted = 0
    public var duplicates = 0
    public var rejected = 0
    public var retried = 0
    public var lastRejection: String?
    public var droppedPose = 0
    public var droppedHigh = 0
    public var droppedOversize = 0
    public var droppedUnencodable = 0
    public var reconnects = 0
    public var backpressure = false
    public var pendingHigh = 0
    public init() {}
}

/// Device connection to /v1/ingest.
///
/// - Authorization header (never a URL token), then clock handshake and session join.
/// - `join` is sent on every new socket and re-sent every `joinRetryInterval` seconds while the
///   server has no session for the device (`no_active_session`) or the joined session ended, so a
///   session created after the phone connected is picked up without reconnecting.
/// - Outgoing queues, batching (count and byte limits) and acknowledgements: `OutboundQueue`.
/// - Sequence numbers come from a `SequenceAllocator` that outlives single connections.
/// - Liveness: an application `ping` every `pingInterval`; no message for `livenessTimeout`
///   means the socket is dead. Any handshake, decode or liveness failure cancels the socket.
/// - Reconnects use exponential backoff that resets after every successful connect.
public actor CoachConnection {
    public struct Configuration: Sendable {
        public var baseURL: URL
        public var token: String
        public var deviceId: String
        public var kind: String
        public var sessionId: String?
        public var maxPoseQueue = 15
        public var maxPendingHigh = 500
        public var batchSize = 50
        /// Server default max_message_bytes is 256 KiB; stay well below it.
        public var maxBatchBytes = 192 * 1024
        public var retryDelay: TimeInterval = 1
        public var joinRetryInterval: TimeInterval = 2
        public var pingInterval: TimeInterval = 10
        public var livenessTimeout: TimeInterval = 25
        public var sequences: SequenceAllocator
        public init(baseURL: URL, token: String, deviceId: String, kind: String, sessionId: String? = nil,
                    sequences: SequenceAllocator = SequenceAllocator()) {
            self.baseURL = baseURL; self.token = token; self.deviceId = deviceId; self.kind = kind
            self.sessionId = sessionId; self.sequences = sequences
        }
    }

    public typealias StatsHandler = @Sendable (ConnectionStats) -> Void
    /// Called with the joined session's control state, or nil when the server has no session for the device.
    public typealias SessionHandler = @Sendable (SessionControl?) -> Void

    private let config: Configuration
    private let urlSession: URLSession
    private var task: URLSessionWebSocketTask?
    private var running = false
    private var generation = 0
    private var queue: OutboundQueue
    private var joinPolicy: JoinPolicy
    private var backoff = Backoff(initial: 0.5, maximum: 10)
    private var currentSession: SessionControl?
    private var noSessionReported = false
    private var lastReceivedAt: TimeInterval = 0
    private var lastPingAt: TimeInterval = 0
    private let onStats: StatsHandler?
    private let onSession: SessionHandler?
    public private(set) var stats = ConnectionStats()

    public init(config: Configuration, urlSession: URLSession = .shared, onStats: StatsHandler? = nil,
                onSession: SessionHandler? = nil) {
        self.config = config
        self.urlSession = urlSession
        self.onStats = onStats
        self.onSession = onSession
        self.queue = OutboundQueue(limits: .init(maxPoseQueue: config.maxPoseQueue, maxPendingHigh: config.maxPendingHigh,
                                                 batchSize: config.batchSize, maxBatchBytes: config.maxBatchBytes,
                                                 retryDelay: config.retryDelay))
        self.joinPolicy = JoinPolicy(pinnedSessionId: config.sessionId, interval: config.joinRetryInterval)
    }

    public var session: SessionControl? { currentSession }

    public func start() {
        guard !running else { return }
        running = true
        generation += 1
        let generation = self.generation
        Task { await self.runLoop(generation: generation) }
    }

    public func stop() {
        running = false
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        config.sequences.flush()
        update(state: "stopped")
    }

    /// Queue an event. Events created before the session is known get its id at send time.
    public func enqueue(_ event: OutgoingEvent) {
        queue.enqueue(event)
        syncQueueStats()
    }

    // MARK: - connection loop

    static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    private var ingestURL: URL {
        var components = URLComponents(url: config.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = (components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path) + "/v1/ingest"
        return components.url!
    }

    private func runLoop(generation: Int) async {
        while running && generation == self.generation {
            do {
                try await connectOnce()
            } catch {
                if running { stats.lastError = ConnectionDiagnostics.explain(error, baseURL: config.baseURL) }
            }
            guard running, generation == self.generation else { break }
            stats.reconnects += 1
            queue.requeueForReconnect()              // unacknowledged first; stale pose frames dropped
            syncQueueStats()
            let delay = backoff.next()
            update(state: String(format: "reconnecting in %.1f s", delay))
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        }
    }

    private func connectOnce() async throws {
        var request = URLRequest(url: ingestURL)
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        let task = urlSession.webSocketTask(with: request)
        task.maximumMessageSize = 1 << 20
        self.task = task
        task.resume()
        update(state: "connecting")
        defer {
            task.cancel(with: .goingAway, reason: nil)     // never leave a half-open socket behind
            if self.task === task { self.task = nil }
        }
        guard case .authOk = try await receive(task) else {
            throw ConnectionDiagnostics.Failure(message: "Authentication failed: pair the device again.")
        }
        try await synchronizeClock(task)
        currentSession = nil                                  // learn the session from this socket's join
        noSessionReported = false
        let now = Self.now()
        joinPolicy.markSent(now: now)
        try await sendJSON(task, joinMessage())
        backoff.reset()                                       // connected: next failure retries quickly
        lastReceivedAt = now
        lastPingAt = now
        update(state: "connected")
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await self.receiveLoop(task) }
            group.addTask { try await self.sendLoop(task) }
            group.addTask { try await self.maintenanceLoop(task) }
            do {
                _ = try await group.next()
            } catch {
                // URLSession's async send/receive do not react to task cancellation; cancelling
                // the socket makes the other loops fail promptly so the group can finish.
                task.cancel(with: .goingAway, reason: nil)
                group.cancelAll()
                throw error
            }
            task.cancel(with: .goingAway, reason: nil)
            group.cancelAll()
        }
    }

    private func joinMessage() -> [String: Any] {
        ["type": "join", "session_id": config.sessionId as Any? ?? NSNull()]
    }

    private func synchronizeClock(_ task: URLSessionWebSocketTask, rounds: Int = 5) async throws {
        for _ in 0..<rounds {
            let t0 = Date().timeIntervalSince1970 * 1000
            try await sendJSON(task, ["type": "clock.ping", "t0": t0])
            guard case let .clockPong(_, t1, t2) = try await receive(task) else { continue }
            let t3 = Date().timeIntervalSince1970 * 1000
            try await sendJSON(task, ["type": "clock.sample", "t0": t0, "t1": t1, "t2": t2, "t3": t3])
            if case let .clockEstimate(offset, uncertainty, _) = try await receive(task) {
                stats.clockOffsetMs = offset
                stats.clockUncertaintyMs = uncertainty
            }
        }
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask) async throws {
        while running {
            let message = try await receive(task)
            lastReceivedAt = Self.now()
            switch message {
            case .ack(let results):
                let summary = queue.acknowledge(results, now: lastReceivedAt)
                stats.accepted += summary.accepted
                stats.duplicates += summary.duplicates
                stats.rejected += summary.rejected
                if let rejection = summary.lastRejection { stats.lastRejection = rejection }
                syncQueueStats()
                onStats?(stats)
            case .session(let control):
                currentSession = control
                noSessionReported = false
                stats.sessionId = control.sessionId
                stats.sessionState = control.state
                if JoinPolicy.needsSession(control, pinned: config.sessionId) {
                    stats.state = "connected, waiting for a new session"
                } else {
                    stats.state = "connected"
                }
                onSession?(control)
                onStats?(stats)
            case .backpressure(let on, _):
                stats.backpressure = on
                onStats?(stats)
            case .error(let code, let message) where code == "no_active_session" || code == "session_not_found":
                // Answer to a join: keep re-sending join until a session exists.
                stats.state = "connected, waiting for a session (create one on the Mac)"
                if !noSessionReported {
                    noSessionReported = true
                    stats.lastError = "\(code): \(message)"
                    if currentSession == nil {
                        stats.sessionId = nil
                        stats.sessionState = nil
                    }
                    onSession?(nil)
                    onStats?(stats)
                }
            case .error(let code, let message):
                stats.lastError = "\(code): \(message)"
                onStats?(stats)
            default:
                break
            }
        }
    }

    private func sendLoop(_ task: URLSessionWebSocketTask) async throws {
        while running {
            guard let session = currentSession, session.state != "ended" else {
                try await Task.sleep(nanoseconds: 50_000_000)
                continue
            }
            let batch = queue.nextBatch(sessionId: session.sessionId, backpressure: stats.backpressure,
                                        sequences: config.sequences)
            guard let batch else {
                syncQueueStats()
                try await Task.sleep(nanoseconds: 20_000_000)
                continue
            }
            try await task.send(.string(String(decoding: batch.data, as: UTF8.self)))
            stats.sent += batch.events.count
            syncQueueStats()
        }
    }

    /// Join retries, retryable-rejection resends, keep-alive pings and the liveness check.
    private func maintenanceLoop(_ task: URLSessionWebSocketTask) async throws {
        while running {
            try await Task.sleep(nanoseconds: 250_000_000)
            let now = Self.now()
            if now - lastReceivedAt > config.livenessTimeout {
                throw ConnectionDiagnostics.Failure(
                    message: "No message from the server for \(Int(config.livenessTimeout)) s; reconnecting.")
            }
            if joinPolicy.shouldSend(session: currentSession, now: now) { sendWithoutWaiting(task, joinMessage()) }
            queue.releaseDueRetries(now: now)
            if now - lastPingAt >= config.pingInterval {
                lastPingAt = now
                sendWithoutWaiting(task, ["type": "ping"])
            }
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) async throws -> IngestServerMessage {
        let message = try await task.receive()
        let data: Data
        switch message {
        case .string(let text): data = Data(text.utf8)
        case .data(let raw): data = raw
        @unknown default: return .unknown("binary")
        }
        return try WireCoding.makeDecoder().decode(IngestServerMessage.self, from: data)
    }

    private func sendJSON(_ task: URLSessionWebSocketTask, _ object: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: object)
        try await task.send(.string(String(decoding: data, as: UTF8.self)))
    }

    /// Small control messages that must not block the maintenance loop on a stalled socket.
    private func sendWithoutWaiting(_ task: URLSessionWebSocketTask, _ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        task.send(.string(String(decoding: data, as: UTF8.self))) { _ in }
    }

    private func syncQueueStats() {
        let counters = queue.counters
        stats.droppedPose = counters.droppedPose
        stats.droppedHigh = counters.droppedHigh
        stats.droppedOversize = counters.droppedOversize
        stats.droppedUnencodable = counters.droppedUnencodable
        stats.retried = counters.retried
        stats.pendingHigh = queue.pendingHigh
    }

    private func update(state: String) {
        stats.state = state
        onStats?(stats)
    }
}

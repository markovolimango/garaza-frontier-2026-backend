import Foundation

/// Messages the server sends on /v1/ingest.
public enum IngestServerMessage: Decodable, Sendable {
    case authOk(deviceId: String, serverTimeMs: Double)
    case clockPong(t0: Double?, t1: Double, t2: Double)
    case clockEstimate(offsetMs: Double, uncertaintyMs: Double, rttMs: Double)
    case session(SessionControl)
    case ack([AckResult])
    case backpressure(on: Bool, queueLevel: Double)
    case error(code: String, message: String)
    case pong
    case unknown(String)

    enum Keys: String, CodingKey {
        case type, deviceId = "device_id", serverTimeMs = "server_time_ms", t0, t1, t2
        case offsetMs = "offset_ms", uncertaintyMs = "uncertainty_ms", rttMs = "rtt_ms", session, results
        case state, queueLevel = "queue_level", error
    }

    struct ErrorBody: Decodable { let code: String; let message: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "auth.ok":
            self = .authOk(deviceId: try c.decode(String.self, forKey: .deviceId),
                           serverTimeMs: try c.decode(Double.self, forKey: .serverTimeMs))
        case "clock.pong":
            self = .clockPong(t0: try c.decodeIfPresent(Double.self, forKey: .t0),
                              t1: try c.decode(Double.self, forKey: .t1), t2: try c.decode(Double.self, forKey: .t2))
        case "clock.estimate":
            self = .clockEstimate(offsetMs: try c.decode(Double.self, forKey: .offsetMs),
                                  uncertaintyMs: try c.decode(Double.self, forKey: .uncertaintyMs),
                                  rttMs: try c.decode(Double.self, forKey: .rttMs))
        case "session":
            self = .session(try c.decode(SessionControl.self, forKey: .session))
        case "ack":
            self = .ack(try c.decode([AckResult].self, forKey: .results))
        case "backpressure":
            self = .backpressure(on: try c.decode(String.self, forKey: .state) == "on",
                                 queueLevel: try c.decode(Double.self, forKey: .queueLevel))
        case "error":
            let body = try c.decode(ErrorBody.self, forKey: .error)
            self = .error(code: body.code, message: body.message)
        case "pong":
            self = .pong
        default:
            self = .unknown(type)
        }
    }
}

public struct SessionControl: Codable, Equatable, Sendable {
    public var sessionId: String
    public var state: String
    public var micSource: String
    public var simulated: Bool
    public var timeline: String
    public var language: String
    public var poseRateHz: Double

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id", state, micSource = "mic_source", simulated, timeline, language
        case poseRateHz = "pose_rate_hz"
    }
}

public struct AckResult: Codable, Equatable, Sendable {
    public var eventId: String?
    public var status: String          // accepted | duplicate | rejected
    public var code: String?
    public var message: String?
    public var retryable: Bool?

    enum CodingKeys: String, CodingKey { case eventId = "event_id", status, code, message, retryable }
}

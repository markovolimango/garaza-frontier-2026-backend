import Foundation

/// Wire contract v1.0 (mirrors services/coach/coach/wire.py and contracts/schemas).
/// Keys are explicit snake_case; times are UTC ISO 8601 with milliseconds; missing values are omitted (null).
public enum WireCoding {
    public static let schemaVersion = "1.0"

    public static func iso(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    public static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(WireCoding.iso(date))
        }
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    public static func makeDecoder() -> JSONDecoder {
        JSONDecoder()
    }
}

/// Minimal JSON value for free-form dictionaries (device capability details).
public enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}

public struct SourceInfo: Codable, Equatable, Sendable {
    public var deviceId: String
    public var kind: String          // iphone | watch | mac | simulator
    public var simulated: Bool
    public var relayDeviceId: String?

    enum CodingKeys: String, CodingKey {
        case deviceId = "device_id", kind, simulated, relayDeviceId = "relay_device_id"
    }

    public init(deviceId: String, kind: String, simulated: Bool = false, relayDeviceId: String? = nil) {
        self.deviceId = deviceId; self.kind = kind; self.simulated = simulated; self.relayDeviceId = relayDeviceId
    }
}

public enum EventType: String, Codable, Sendable {
    case deviceStatus = "device.status"
    case poseFrame = "pose.frame"
    case speechActivity = "speech.activity"
    case transcriptPartial = "speech.transcript.partial"
    case transcriptFinal = "speech.transcript.final"
    case heartRateSample = "heart_rate.sample"
    case audioPlayback = "audio.playback"
    case systemWarning = "system.warning"

    /// Control, speech and heart-rate events are kept until acknowledged; pose frames are droppable.
    public var isHighPriority: Bool { self != .poseFrame }
}

public enum EventPayload: Encodable, Sendable {
    case pose(PoseFramePayload)
    case deviceStatus(DeviceStatusPayload)
    case speechActivity(SpeechActivityPayload)
    case transcript(TranscriptPayload)
    case heartRate(HeartRateSamplePayload)
    case playback(AudioPlaybackPayload)
    case warning(SystemWarningPayload)

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .pose(let p): try p.encode(to: encoder)
        case .deviceStatus(let p): try p.encode(to: encoder)
        case .speechActivity(let p): try p.encode(to: encoder)
        case .transcript(let p): try p.encode(to: encoder)
        case .heartRate(let p): try p.encode(to: encoder)
        case .playback(let p): try p.encode(to: encoder)
        case .warning(let p): try p.encode(to: encoder)
        }
    }
}

/// Device -> server envelope. `sequence` is assigned by the transport at first transmission.
public struct OutgoingEvent: Encodable, Sendable {
    public let schemaVersion = WireCoding.schemaVersion
    public let eventId: String
    public var sessionId: String
    public let source: SourceInfo
    public var sequence: Int?
    public let eventType: EventType
    public let capturedAt: Date
    public let sourceMonotonicMs: Double?
    public let payload: EventPayload

    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", eventId = "event_id", sessionId = "session_id", source, sequence
        case eventType = "event_type", capturedAt = "captured_at", sourceMonotonicMs = "source_monotonic_ms", payload
    }

    public init(sessionId: String, source: SourceInfo, eventType: EventType, capturedAt: Date,
                payload: EventPayload, eventId: String = "ev-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(20),
                sourceMonotonicMs: Double? = ProcessInfo.processInfo.systemUptime * 1000) {
        self.eventId = eventId; self.sessionId = sessionId; self.source = source; self.eventType = eventType
        self.capturedAt = capturedAt; self.payload = payload; self.sourceMonotonicMs = sourceMonotonicMs
    }
}

// MARK: - payloads

public struct Point2D: Codable, Equatable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

public struct Joint2D: Codable, Equatable, Sendable {
    public var name: String
    public var x: Double
    public var y: Double
    public var confidence: Double
    public init(name: String, x: Double, y: Double, confidence: Double) {
        self.name = name; self.x = x; self.y = y; self.confidence = confidence
    }
}

public struct Joint3D: Codable, Equatable, Sendable {
    public var name: String
    public var positionM: [Double]
    public var localPositionM: [Double]?
    public var parent: String?
    public var imagePoint: Point2D?

    enum CodingKeys: String, CodingKey {
        case name, positionM = "position_m", localPositionM = "local_position_m", parent, imagePoint = "image_point"
    }

    public init(name: String, positionM: [Double], localPositionM: [Double]?, parent: String?, imagePoint: Point2D?) {
        self.name = name; self.positionM = positionM; self.localPositionM = localPositionM
        self.parent = parent; self.imagePoint = imagePoint
    }
}

public struct ImageInfo: Codable, Equatable, Sendable {
    public var width: Int
    public var height: Int
    public var orientation: String       // up | down | left | right | *_mirrored
    public var mirrored: Bool
    public var cameraPosition: String    // back | front | external | unspecified

    enum CodingKeys: String, CodingKey {
        case width, height, orientation, mirrored, cameraPosition = "camera_position"
    }

    public init(width: Int, height: Int, orientation: String = "up", mirrored: Bool = false,
                cameraPosition: String = "unspecified") {
        self.width = width; self.height = height; self.orientation = orientation
        self.mirrored = mirrored; self.cameraPosition = cameraPosition
    }
}

public struct PoseFramePayload: Codable, Equatable, Sendable {
    public var mode: String                       // "3d" | "2d"
    public var detector: String
    public var detectorRevision: Int?
    public var image: ImageInfo
    public var personsDetected: Int
    public var trackingState: String              // tracking | no_person | interrupted
    public var inferenceMs: Double?
    public var droppedFramesSinceLast: Int
    public var coordinateSpace2D = "image_normalized_top_left"
    public var coordinateSpace3D: String?
    public var joints2D: [Joint2D]?
    public var joints3D: [Joint3D]?
    public var bodyHeightM: Double?
    public var heightEstimation: String?
    public var cameraOriginMatrix: [Double]?
    public var observationConfidence: Double?
    public var rootCameraPositionM: [Double]?

    enum CodingKeys: String, CodingKey {
        case mode, detector, detectorRevision = "detector_revision", image, personsDetected = "persons_detected"
        case trackingState = "tracking_state", inferenceMs = "inference_ms"
        case droppedFramesSinceLast = "dropped_frames_since_last", coordinateSpace2D = "coordinate_space_2d"
        case coordinateSpace3D = "coordinate_space_3d", joints2D = "joints_2d", joints3D = "joints_3d"
        case bodyHeightM = "body_height_m", heightEstimation = "height_estimation"
        case cameraOriginMatrix = "camera_origin_matrix", observationConfidence = "observation_confidence"
        case rootCameraPositionM = "root_camera_position_m"
    }

    public init(mode: String, detector: String, detectorRevision: Int? = nil, image: ImageInfo, personsDetected: Int,
                trackingState: String, inferenceMs: Double?, droppedFramesSinceLast: Int = 0) {
        self.mode = mode; self.detector = detector; self.detectorRevision = detectorRevision; self.image = image
        self.personsDetected = personsDetected; self.trackingState = trackingState; self.inferenceMs = inferenceMs
        self.droppedFramesSinceLast = droppedFramesSinceLast
    }
}

public struct DeviceStatusPayload: Codable, Equatable, Sendable {
    public var status: String                    // online | offline | heartbeat | interrupted | resumed
    public var subjectDeviceId: String?
    public var appVersion: String?
    public var osVersion: String?
    public var model: String?
    public var poseMode: String?
    public var poseRateHz: Double?
    public var speech: [String: JSONValue]?
    public var watch: [String: JSONValue]?
    public var thermalState: String?
    public var reason: String?

    enum CodingKeys: String, CodingKey {
        case status, subjectDeviceId = "subject_device_id", appVersion = "app_version", osVersion = "os_version"
        case model, poseMode = "pose_mode", poseRateHz = "pose_rate_hz", speech, watch
        case thermalState = "thermal_state", reason
    }

    public init(status: String, reason: String? = nil) { self.status = status; self.reason = reason }
}

public struct SpeechActivityPayload: Codable, Equatable, Sendable {
    public var transition: String                // speech_start | speech_end
    public var vadMethod: String
    public var levelDbfs: Double?
    public var thresholdDbfs: Double?
    public var noiseFloorDbfs: Double?
    public var calibrated: Bool

    enum CodingKeys: String, CodingKey {
        case transition, vadMethod = "vad_method", levelDbfs = "level_dbfs", thresholdDbfs = "threshold_dbfs"
        case noiseFloorDbfs = "noise_floor_dbfs", calibrated
    }

    public init(transition: String, vadMethod: String, levelDbfs: Double?, thresholdDbfs: Double?,
                noiseFloorDbfs: Double?, calibrated: Bool) {
        self.transition = transition; self.vadMethod = vadMethod; self.levelDbfs = levelDbfs
        self.thresholdDbfs = thresholdDbfs; self.noiseFloorDbfs = noiseFloorDbfs; self.calibrated = calibrated
    }
}

public struct TranscriptSegment: Codable, Equatable, Sendable {
    public var text: String
    public var startS: Double
    public var durationS: Double
    public var confidence: Double?

    enum CodingKeys: String, CodingKey { case text, startS = "start_s", durationS = "duration_s", confidence }

    public init(text: String, startS: Double, durationS: Double, confidence: Double?) {
        self.text = text; self.startS = startS; self.durationS = durationS; self.confidence = confidence
    }
}

public struct TranscriptPayload: Codable, Equatable, Sendable {
    public var utteranceId: String
    public var revision: Int
    public var text: String
    public var language: String
    public var onDevice: Bool
    public var audioStartAt: Date?
    public var segments: [TranscriptSegment]?
    public var recognizer: String

    enum CodingKeys: String, CodingKey {
        case utteranceId = "utterance_id", revision, text, language, onDevice = "on_device"
        case audioStartAt = "audio_start_at", segments, recognizer
    }

    public init(utteranceId: String, revision: Int, text: String, language: String, onDevice: Bool,
                audioStartAt: Date?, segments: [TranscriptSegment]?, recognizer: String = "SFSpeechRecognizer") {
        self.utteranceId = utteranceId; self.revision = revision; self.text = text; self.language = language
        self.onDevice = onDevice; self.audioStartAt = audioStartAt; self.segments = segments; self.recognizer = recognizer
    }
}

public struct HeartRateSamplePayload: Codable, Equatable, Sendable {
    public var bpm: Double
    public var measuredAt: Date
    public var sampleAgeMsAtSend: Double?
    public var collectionMode: String            // passive_healthkit | workout_session | simulated
    public var delivery: String                  // live_message | queued_transfer | application_context | direct
    public var availability: String
    public var hkSampleUUID: String?
    public var hrvSDNNms: Double?

    enum CodingKeys: String, CodingKey {
        case bpm, measuredAt = "measured_at", sampleAgeMsAtSend = "sample_age_ms_at_send"
        case collectionMode = "collection_mode", delivery, availability, hkSampleUUID = "hk_sample_uuid"
        case hrvSDNNms = "hrv_sdnn_ms"
    }

    public init(bpm: Double, measuredAt: Date, sampleAgeMsAtSend: Double?, collectionMode: String, delivery: String,
                availability: String = "available", hkSampleUUID: String? = nil, hrvSDNNms: Double? = nil) {
        self.bpm = bpm; self.measuredAt = measuredAt; self.sampleAgeMsAtSend = sampleAgeMsAtSend
        self.collectionMode = collectionMode; self.delivery = delivery; self.availability = availability
        self.hkSampleUUID = hkSampleUUID; self.hrvSDNNms = hrvSDNNms
    }
}

public struct AudioPlaybackPayload: Codable, Equatable, Sendable {
    public var state: String                     // scheduled | started | finished | interrupted | skipped
    public var playbackId: String
    public var feedbackId: String?
    public var engine: String                    // avspeechsynthesizer | audio_clip | text_only
    public var voice: String?
    public var language: String?
    public var text: String?
    public var reason: String?

    enum CodingKeys: String, CodingKey {
        case state, playbackId = "playback_id", feedbackId = "feedback_id", engine, voice, language, text, reason
    }

    public init(state: String, playbackId: String, feedbackId: String?, engine: String, voice: String? = nil,
                language: String? = nil, text: String? = nil, reason: String? = nil) {
        self.state = state; self.playbackId = playbackId; self.feedbackId = feedbackId; self.engine = engine
        self.voice = voice; self.language = language; self.text = text; self.reason = reason
    }
}

public struct SystemWarningPayload: Codable, Equatable, Sendable {
    public var code: String
    public var message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
}

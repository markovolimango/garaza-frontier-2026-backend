import CoachWire
import Foundation
import Testing

/// Cross-language contract check: JSON produced by Swift must contain every required property of
/// the generated JSON Schema (contracts/schemas) and no property the schema does not define.
enum Schemas {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("contracts/schemas")

    static func load(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: directory.appendingPathComponent("\(name).schema.json"))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }

    static func check(_ json: [String: Any], against schema: [String: Any], defs: [String: Any]? = nil,
                      path: String = "$") -> [String] {
        let defs = defs ?? (schema["$defs"] as? [String: Any] ?? [:])
        var problems: [String] = []
        let properties = schema["properties"] as? [String: Any] ?? [:]
        for required in schema["required"] as? [String] ?? [] where json[required] == nil {
            problems.append("\(path).\(required) missing")
        }
        for (key, value) in json {
            guard let property = properties[key] as? [String: Any] else {
                problems.append("\(path).\(key) not in schema"); continue
            }
            if let nested = value as? [String: Any], let target = resolve(property, defs), target["properties"] != nil {
                problems += check(nested, against: target, defs: defs, path: "\(path).\(key)")
            }
            if let items = value as? [[String: Any]], let target = resolveItems(property, defs) {
                for (index, item) in items.enumerated() {
                    problems += check(item, against: target, defs: defs, path: "\(path).\(key)[\(index)]")
                }
            }
        }
        return problems
    }

    static func resolve(_ property: [String: Any], _ defs: [String: Any]) -> [String: Any]? {
        if let ref = property["$ref"] as? String { return defs[String(ref.split(separator: "/").last!)] as? [String: Any] }
        for option in property["anyOf"] as? [[String: Any]] ?? [] { if let found = resolve(option, defs) { return found } }
        return property["properties"] != nil ? property : nil
    }

    static func resolveItems(_ property: [String: Any], _ defs: [String: Any]) -> [String: Any]? {
        if let items = property["items"] as? [String: Any] { return resolve(items, defs) }
        for option in property["anyOf"] as? [[String: Any]] ?? [] {
            if let items = option["items"] as? [String: Any] { return resolve(items, defs) }
        }
        return nil
    }
}

func encodeObject<T: Encodable>(_ value: T) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: try WireCoding.makeEncoder().encode(value)) as! [String: Any]
}

@Test func posePayloads2DAnd3DMatchSchema() throws {
    var pose2D = PoseFramePayload(mode: "2d", detector: "VNDetectHumanBodyPoseRequest", detectorRevision: 1,
                                  image: ImageInfo(width: 1280, height: 720, cameraPosition: "back"), personsDetected: 1,
                                  trackingState: "tracking", inferenceMs: 11.2)
    pose2D.joints2D = [Joint2D(name: "left_wrist", x: 0.4, y: 0.6, confidence: 0.9)]
    var pose3D = PoseFramePayload(mode: "3d", detector: "VNDetectHumanBodyPose3DRequest", image: ImageInfo(width: 10, height: 10),
                                  personsDetected: 1, trackingState: "tracking", inferenceMs: 80)
    pose3D.coordinateSpace3D = "vision_body_root_m"
    pose3D.joints3D = [Joint3D(name: "left_wrist", positionM: [0.1, 0.2, 0.3], localPositionM: [0, 0.1, 0],
                               parent: "left_elbow", imagePoint: Point2D(x: 0.5, y: 0.5))]
    pose3D.cameraOriginMatrix = Array(repeating: 0, count: 16)
    pose3D.rootCameraPositionM = [0, 0, 2]
    let schema = try Schemas.load("PoseFramePayload")
    for payload in [pose2D, pose3D] {
        let json = try encodeObject(payload)
        #expect(Schemas.check(json, against: schema).isEmpty, "\(Schemas.check(json, against: schema))")
    }
    let keys = try encodeObject(pose2D).keys
    #expect(keys.contains("joints_2d") && keys.contains("coordinate_space_2d") && !keys.contains("joints2D"))
}

@Test func envelopeAndOtherPayloadsMatchSchema() throws {
    let measured = Date(timeIntervalSince1970: 1_800_000_000.25)
    let heart = HeartRateSamplePayload(bpm: 81, measuredAt: measured, sampleAgeMsAtSend: 1200, collectionMode: "workout_session",
                                       delivery: "live_message", hkSampleUUID: "ABC")
    let event = OutgoingEvent(sessionId: "ses_1", source: SourceInfo(deviceId: "watch-1", kind: "watch", relayDeviceId: "iphone-1"),
                              eventType: .heartRateSample, capturedAt: measured, payload: .heartRate(heart))
    var withSequence = event
    withSequence.sequence = 3
    let json = try encodeObject(withSequence)
    #expect(Schemas.check(json, against: try Schemas.load("EventIn")).isEmpty)
    #expect(json["captured_at"] as? String == "2027-01-15T08:00:00.250Z")
    #expect(Schemas.check(json["payload"] as! [String: Any], against: try Schemas.load("HeartRateSamplePayload")).isEmpty)

    let transcript = TranscriptPayload(utteranceId: "utt-1", revision: 2, text: "hello there", language: "en-US", onDevice: true,
                                       audioStartAt: measured, segments: [TranscriptSegment(text: "hello", startS: 0, durationS: 0.3, confidence: nil)])
    #expect(Schemas.check(try encodeObject(transcript), against: try Schemas.load("TranscriptPayload")).isEmpty)
    let activity = SpeechActivityPayload(transition: "speech_start", vadMethod: EnergyMethod.name, levelDbfs: -20,
                                         thresholdDbfs: -40, noiseFloorDbfs: -50, calibrated: true)
    #expect(Schemas.check(try encodeObject(activity), against: try Schemas.load("SpeechActivityPayload")).isEmpty)
    var status = DeviceStatusPayload(status: "online")
    status.watch = ["reachable": .bool(true), "authorized": .null]
    status.thermalState = "nominal"
    #expect(Schemas.check(try encodeObject(status), against: try Schemas.load("DeviceStatusPayload")).isEmpty)
    let playback = AudioPlaybackPayload(state: "started", playbackId: "pb-1", feedbackId: "fb-1", engine: "avspeechsynthesizer")
    #expect(Schemas.check(try encodeObject(playback), against: try Schemas.load("AudioPlaybackPayload")).isEmpty)
}

enum EnergyMethod { static let name = "energy_threshold_heuristic_v1" }

@Test func decodesServerMessages() throws {
    let decoder = WireCoding.makeDecoder()
    func decode(_ text: String) throws -> IngestServerMessage { try decoder.decode(IngestServerMessage.self, from: Data(text.utf8)) }
    guard case .authOk(let id, _) = try decode(#"{"type":"auth.ok","device_id":"iphone-1","kind":"iphone","schema_version":"1.0","server_time_ms":1,"limits":{}}"#)
    else { Issue.record("auth.ok"); return }
    #expect(id == "iphone-1")
    guard case .ack(let results) = try decode(#"{"type":"ack","results":[{"event_id":"e1","status":"accepted"},{"event_id":"e2","status":"rejected","code":"queue_full","retryable":true}]}"#)
    else { Issue.record("ack"); return }
    #expect(results.count == 2 && results[1].retryable == true)
    guard case .session(let control) = try decode(#"{"type":"session","session":{"session_id":"ses_1","state":"running","mic_source":"iphone","simulated":false,"timeline":"live","language":"en-US","pose_rate_hz":12}}"#)
    else { Issue.record("session"); return }
    #expect(control.state == "running" && control.poseRateHz == 12)
    guard case .backpressure(let on, _) = try decode(#"{"type":"backpressure","state":"on","lane":"pose","queue_level":0.8}"#)
    else { Issue.record("backpressure"); return }
    #expect(on)
    guard case .unknown = try decode(#"{"type":"future.thing"}"#) else { Issue.record("unknown"); return }
}

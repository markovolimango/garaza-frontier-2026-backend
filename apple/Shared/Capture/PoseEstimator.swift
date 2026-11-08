#if canImport(Vision)
import CoachWire
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import simd
import Vision

/// Runs Vision body pose on one image at a time and produces wire payloads.
///
/// Preferred: VNDetectHumanBodyPose3DRequest (iOS 17 / macOS 14): 17 joints in meters relative to
/// the root (hip), no per-joint confidence. Fallback: VNDetectHumanBodyPoseRequest (2D): 19 joints,
/// normalized image coordinates with confidence. The active mode and any fallback reason are reported.
public final class PoseEstimator {
    public enum Preference: String, Sendable { case prefer3D = "auto", only2D = "2d", only3D = "3d" }

    public private(set) var activeMode: String
    public private(set) var fallbackReason: String?
    public let preference: Preference
    private let request3D = VNDetectHumanBodyPose3DRequest()
    private let request2D = VNDetectHumanBodyPoseRequest()
    private let sequenceHandler = VNSequenceRequestHandler()   // keeps state for the stateful 3D request
    private var consecutive3DFailures = 0

    public init(preference: Preference = .prefer3D) {
        self.preference = preference
        activeMode = preference == .only2D ? "2d" : "3d"
    }

    public struct Input {
        public var cgImage: CGImage?
        public var pixelBuffer: CVPixelBuffer?
        public var orientation: CGImagePropertyOrientation
        public var width: Int
        public var height: Int
        public var mirrored: Bool
        public var cameraPosition: String
        public init(cgImage: CGImage? = nil, pixelBuffer: CVPixelBuffer? = nil, orientation: CGImagePropertyOrientation = .up,
                    width: Int, height: Int, mirrored: Bool = false, cameraPosition: String = "unspecified") {
            self.cgImage = cgImage; self.pixelBuffer = pixelBuffer; self.orientation = orientation
            self.width = width; self.height = height; self.mirrored = mirrored; self.cameraPosition = cameraPosition
        }
    }

    /// Process one frame. `live` frames use the sequence handler (3D request state across frames).
    public func process(_ input: Input, live: Bool, droppedSinceLast: Int = 0) -> PoseFramePayload {
        let image = ImageInfo(width: input.width, height: input.height, orientation: Self.name(input.orientation),
                              mirrored: input.mirrored, cameraPosition: input.cameraPosition)
        if activeMode == "3d" {
            do {
                return try run3D(input, image: image, live: live, dropped: droppedSinceLast)
            } catch {
                consecutive3DFailures += 1
                if preference == .only3D {
                    return PoseFramePayload(mode: "3d", detector: "VNDetectHumanBodyPose3DRequest", image: image,
                                            personsDetected: 0, trackingState: "no_person", inferenceMs: nil,
                                            droppedFramesSinceLast: droppedSinceLast)
                }
                if consecutive3DFailures >= 3 {
                    activeMode = "2d"
                    fallbackReason = "3D body pose failed repeatedly: \(error.localizedDescription)"
                }
            }
        }
        return run2D(input, image: image, live: live, dropped: droppedSinceLast)
    }

    private func perform(_ request: VNRequest, _ input: Input, live: Bool) throws {
        if let buffer = input.pixelBuffer {
            if live {
                try sequenceHandler.perform([request], on: buffer, orientation: input.orientation)
            } else {
                try VNImageRequestHandler(cvPixelBuffer: buffer, orientation: input.orientation).perform([request])
            }
        } else if let cgImage = input.cgImage {
            if live {
                try sequenceHandler.perform([request], on: cgImage, orientation: input.orientation)
            } else {
                try VNImageRequestHandler(cgImage: cgImage, orientation: input.orientation).perform([request])
            }
        } else {
            throw ConnectionlessError.noImage
        }
    }

    enum ConnectionlessError: Error { case noImage }

    private func run3D(_ input: Input, image: ImageInfo, live: Bool, dropped: Int) throws -> PoseFramePayload {
        let started = DispatchTime.now()
        try perform(request3D, input, live: live)
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6
        consecutive3DFailures = 0
        let observations = request3D.results ?? []
        var payload = PoseFramePayload(mode: "3d", detector: "VNDetectHumanBodyPose3DRequest",
                                       detectorRevision: request3D.revision, image: image,
                                       personsDetected: observations.count,
                                       trackingState: observations.isEmpty ? "no_person" : "tracking",
                                       inferenceMs: ms, droppedFramesSinceLast: dropped)
        payload.coordinateSpace3D = "vision_body_root_m"
        guard let observation = observations.first else { return payload }
        var joints: [CoachWire.Joint3D] = []
        for (vision, name) in PoseJoints.names3D where observation.availableJointNames.contains(vision) {
            guard let point = try? observation.recognizedPoint(vision) else { continue }
            let position = point.position.columns.3
            let local = point.localPosition.columns.3
            var imagePoint: CoachWire.Point2D?
            if let projected = try? observation.pointInImage(vision) {
                let p = PoseJoints.topLeft(x: Double(projected.x), y: Double(projected.y))
                imagePoint = CoachWire.Point2D(x: p.x, y: p.y)
            }
            joints.append(CoachWire.Joint3D(name: name, positionM: [Double(position.x), Double(position.y), Double(position.z)],
                                  localPositionM: [Double(local.x), Double(local.y), Double(local.z)],
                                  parent: point.parentJoint == vision ? nil : PoseJoints.lookup3D[point.parentJoint], imagePoint: imagePoint))
        }
        payload.joints3D = joints
        payload.bodyHeightM = Double(observation.bodyHeight)
        payload.heightEstimation = observation.heightEstimation == .measured ? "measured" : "reference"
        let m = observation.cameraOriginMatrix
        payload.cameraOriginMatrix = [m.columns.0, m.columns.1, m.columns.2, m.columns.3]
            .flatMap { [Double($0.x), Double($0.y), Double($0.z), Double($0.w)] }
        if let root = try? observation.cameraRelativePosition(.root) {
            payload.rootCameraPositionM = [Double(root.columns.3.x), Double(root.columns.3.y), Double(root.columns.3.z)]
        }
        payload.observationConfidence = Double(observation.confidence)
        return payload
    }

    private func run2D(_ input: Input, image: ImageInfo, live: Bool, dropped: Int) -> PoseFramePayload {
        let started = DispatchTime.now()
        let ok = (try? perform(request2D, input, live: live)) != nil
        let ms = Double(DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1e6
        let observations = ok ? (request2D.results ?? []) : []
        var payload = PoseFramePayload(mode: "2d", detector: "VNDetectHumanBodyPoseRequest",
                                       detectorRevision: request2D.revision, image: image,
                                       personsDetected: observations.count,
                                       trackingState: observations.isEmpty ? "no_person" : "tracking",
                                       inferenceMs: ok ? ms : nil, droppedFramesSinceLast: dropped)
        // Several people: report the most confident (largest summed joint confidence) one.
        let best = observations.max { score($0) < score($1) }
        guard let observation = best, let points = try? observation.recognizedPoints(.all) else { return payload }
        payload.joints2D = PoseJoints.names2D.compactMap { vision, name in
            guard let point = points[vision], point.confidence > 0 else { return nil }
            let p = PoseJoints.topLeft(x: Double(point.location.x), y: Double(point.location.y))
            return CoachWire.Joint2D(name: name, x: p.x, y: p.y, confidence: Double(point.confidence))
        }
        payload.observationConfidence = Double(observation.confidence)
        return payload
    }

    private func score(_ observation: VNHumanBodyPoseObservation) -> Float {
        ((try? observation.recognizedPoints(.all)) ?? [:]).values.reduce(0) { $0 + $1.confidence }
    }

    static func name(_ orientation: CGImagePropertyOrientation) -> String {
        switch orientation {
        case .up: return "up"
        case .down: return "down"
        case .left: return "left"
        case .right: return "right"
        case .upMirrored: return "up_mirrored"
        case .downMirrored: return "down_mirrored"
        case .leftMirrored: return "left_mirrored"
        case .rightMirrored: return "right_mirrored"
        @unknown default: return "up"
        }
    }
}
#endif

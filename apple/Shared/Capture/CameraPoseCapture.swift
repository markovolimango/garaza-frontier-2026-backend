#if canImport(AVFoundation) && canImport(Vision)
import AVFoundation
import CoachWire
import CoreMedia
import Foundation

/// Camera capture feeding PoseEstimator with exactly one inference in flight.
///
/// Frames are processed synchronously on the capture queue; while a frame is being analysed
/// AVFoundation discards late frames (alwaysDiscardsLateVideoFrames), and frames arriving faster
/// than the configured rate are skipped. Both are counted in dropped_frames_since_last.
/// Capture time comes from the sample buffer's presentation time (host clock), converted to wall time.
/// Buffers are rotated to be level with the horizon (AVCaptureDevice.RotationCoordinator), so the
/// phone can stand in portrait or landscape; the analysed width/height follow the rotation.
///
/// Concurrency: `configure` runs before `start`; afterwards all mutable state (estimator, rate
/// limiter, drop counter, connection rotation) is touched only on `queue`. Handlers are called on
/// `queue` (frames) or the notification thread (status).
public final class CameraPoseCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    public typealias FrameHandler = @Sendable (PoseFramePayload, Date, _ fallbackReason: String?) -> Void
    public typealias StatusHandler = @Sendable (_ status: String, _ reason: String?) -> Void

    public let session = AVCaptureSession()
    public let targetRateHz: Double
    private let estimator: PoseEstimator
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "coach.camera.pose")
    private let onFrame: FrameHandler
    private let onStatus: StatusHandler
    private var lastProcessed: Date = .distantPast
    private var dropped = 0
    private var position: AVCaptureDevice.Position = .back
    private var observers: [NSObjectProtocol] = []
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?

    public init(targetRateHz: Double = 12, preference: PoseEstimator.Preference = .prefer3D,
                onFrame: @escaping FrameHandler, onStatus: @escaping StatusHandler) {
        self.targetRateHz = targetRateHz
        self.estimator = PoseEstimator(preference: preference)
        self.onFrame = onFrame
        self.onStatus = onStatus
    }

    public static func authorizationStatus() -> AVAuthorizationStatus { AVCaptureDevice.authorizationStatus(for: .video) }
    public static func requestAccess() async -> Bool { await AVCaptureDevice.requestAccess(for: .video) }

    public func configure(position: AVCaptureDevice.Position = .back) throws {
        self.position = position
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .hd1280x720
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position)
                ?? AVCaptureDevice.default(for: .video) else {
            throw ConnectionDiagnosticsError.noCamera
        }
        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else { throw ConnectionDiagnosticsError.cannotAddInput }
        session.addInput(input)
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
        output.setSampleBufferDelegate(self, queue: queue)
        guard session.canAddOutput(output) else { throw ConnectionDiagnosticsError.cannotAddOutput }
        session.addOutput(output)
        if let connection = output.connection(with: .video) {
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = false        // analyse unmirrored frames; overlays mirror separately
            }
            // Follow the physical orientation (gravity), not the portrait-only UI: a landscape tripod works.
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
            Self.apply(coordinator.videoRotationAngleForHorizonLevelCapture, to: connection)
            rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.new]) {
                [weak self] coordinator, _ in
                let angle = coordinator.videoRotationAngleForHorizonLevelCapture
                self?.queue.async { [weak self] in
                    guard let connection = self?.output.connection(with: .video) else { return }
                    Self.apply(angle, to: connection)
                }
            }
            rotationCoordinator = coordinator
        }
        observeInterruptions()
    }

    public enum ConnectionDiagnosticsError: Error { case noCamera, cannotAddInput, cannotAddOutput }

    private static func apply(_ angle: CGFloat, to connection: AVCaptureConnection) {
        if connection.videoRotationAngle != angle, connection.isVideoRotationAngleSupported(angle) {
            connection.videoRotationAngle = angle
        }
    }

    public func start() { queue.async { if !self.session.isRunning { self.session.startRunning() } } }
    public func stop() { queue.async { if self.session.isRunning { self.session.stopRunning() } } }

    private func observeInterruptions() {
        #if os(iOS)
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session,
                                            queue: nil) { [weak self] note in
            let raw = note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? Int
            self?.onStatus("interrupted", raw.map { "AVCaptureSession interruption reason \($0)" })
        })
        observers.append(center.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session,
                                            queue: nil) { [weak self] _ in self?.onStatus("resumed", nil) })
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session,
                                            queue: nil) { [weak self] note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            self?.onStatus("interrupted", error?.localizedDescription ?? "capture runtime error")
        })
        #endif
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    public func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer,
                              from connection: AVCaptureConnection) {
        dropped += 1
    }

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                              from connection: AVCaptureConnection) {
        let captured = Self.wallClock(of: sampleBuffer)
        guard captured.timeIntervalSince(lastProcessed) >= 1.0 / max(targetRateHz, 0.5) else {
            dropped += 1
            return
        }
        guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        lastProcessed = captured
        let input = PoseEstimator.Input(pixelBuffer: buffer, orientation: .up,
                                        width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer),
                                        mirrored: connection.isVideoMirrored,
                                        cameraPosition: position == .front ? "front" : "back")
        let payload = estimator.process(input, live: true, droppedSinceLast: dropped)
        dropped = 0
        onFrame(payload, captured, estimator.fallbackReason)
    }

    /// Presentation timestamps are on the host clock; convert to wall time.
    static func wallClock(of sampleBuffer: CMSampleBuffer) -> Date {
        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        guard pts.isValid, now.isValid else { return Date() }
        let age = CMTimeGetSeconds(CMTimeSubtract(now, pts))
        return Date().addingTimeInterval(-max(0, age))
    }
}
#endif

import CoachCapture
import CoachSpeech
import CoachTransport
import CoachWire
import Foundation
#if canImport(AVFoundation)
import AVFoundation
#endif
#if canImport(UIKit)
import UIKit
#endif

/// Orchestrates the capture device: pairing, connection, permissions, pose, speech and the
/// Watch relay. Capture follows the backend session state (running -> capture; paused/ended/none
/// -> stop). The connection re-joins by itself when a new session is created on the Mac.
/// While capturing on iOS the idle timer is disabled so the phone does not auto-lock mid-practice.
@MainActor
public final class CaptureController: ObservableObject {
    @Published public var endpoint: String { didSet { defaults.set(endpoint, forKey: "coach.endpoint") } }
    @Published public var pairingCode = ""
    @Published public var language: String { didSet { defaults.set(language, forKey: "coach.language") } }
    @Published public var posePreference: String { didSet { defaults.set(posePreference, forKey: "coach.pose_mode") } }
    @Published public var poseRateHz: Double { didSet { defaults.set(poseRateHz, forKey: "coach.pose_rate") } }
    @Published public var speechEnabled: Bool { didSet { defaults.set(speechEnabled, forKey: "coach.speech") } }
    @Published public private(set) var paired = false
    @Published public private(set) var stats = ConnectionStats()
    @Published public private(set) var capturing = false
    @Published public private(set) var poseMode = "off"
    @Published public private(set) var poseFallback: String?
    @Published public private(set) var lastInferenceMs: Double?
    @Published public private(set) var speechStatus = "not checked"
    @Published public private(set) var watchStatus = WatchState()
    @Published public private(set) var message: String?

    public struct WatchState: Equatable, Sendable {
        public var supported = false
        public var paired = false
        public var reachable = false
        public var authorized: Bool?
        public var collectionMode = "off"
        public var lastSampleAge: TimeInterval?
    }

    public let deviceId: String
    private let defaults = UserDefaults.standard
    private var connection: CoachConnection?
    #if canImport(AVFoundation) && canImport(Vision)
    private var camera: CameraPoseCapture?
    #endif
    #if canImport(Speech) && canImport(AVFoundation)
    private var speech: SpeechCapture?
    #endif
    private var watch: WatchBridge?
    private var heartbeat: Timer?
    private var session: SessionControl?
    /// Sequence numbers stay monotonic across Connected toggles and app restarts.
    private let sequences = SequenceAllocator(defaults: .standard)

    public init() {
        endpoint = defaults.string(forKey: "coach.endpoint") ?? "https://your-mac.local:8765"
        language = defaults.string(forKey: "coach.language") ?? "en-US"
        posePreference = defaults.string(forKey: "coach.pose_mode") ?? "auto"
        poseRateHz = defaults.object(forKey: "coach.pose_rate") as? Double ?? 12
        speechEnabled = defaults.object(forKey: "coach.speech") as? Bool ?? true
        #if os(iOS)
        deviceId = DeviceIdentity.deviceId(prefix: "iphone")
        #else
        deviceId = DeviceIdentity.deviceId(prefix: "mac")
        #endif
        paired = baseURL.flatMap { TokenStore.load(account: Self.account($0)) } != nil
        watch = WatchBridge(relayDeviceId: deviceId, onSamples: { [weak self] payloads in
            Task { @MainActor in self?.relayHeart(payloads) }
        }, onStatus: { [weak self] state in
            Task { @MainActor in self?.watchChanged(state) }
        })
        watch?.activate()
        refreshSpeechStatus()
    }

    private var kind: String {
        #if os(iOS)
        return "iphone"
        #else
        return "mac"
        #endif
    }

    public var baseURL: URL? {
        guard let url = URL(string: endpoint.trimmingCharacters(in: .whitespaces)), url.scheme?.hasPrefix("http") == true
        else { return nil }
        return url
    }

    static func account(_ url: URL) -> String { "\(url.host ?? "?"):\(url.port ?? 0)" }

    // MARK: - pairing and connection

    public func pair() async {
        guard let url = baseURL else { message = "Enter the backend URL (https://<mac>.local:8765)."; return }
        do {
            #if canImport(UIKit)
            let name = UIDevice.current.name
            #else
            let name = Host.current().localizedName
            #endif
            let result = try await Pairing.pair(baseURL: url, code: pairingCode, deviceId: deviceId, kind: kind, name: name)
            paired = TokenStore.save(result.deviceToken, account: Self.account(url))
            pairingCode = ""
            message = paired ? "Paired (token stored in the Keychain until \(result.expiresAt))." : "Could not store the token."
        } catch {
            message = ConnectionDiagnostics.explain(error, baseURL: url)
        }
    }

    public func connect() {
        guard let url = baseURL, let token = TokenStore.load(account: Self.account(url)) else {
            message = "Pair this device first."
            return
        }
        if connection != nil { disconnect() }
        let config = CoachConnection.Configuration(baseURL: url, token: token, deviceId: deviceId, kind: kind,
                                                   sequences: sequences)
        let connection = CoachConnection(config: config, onStats: { [weak self] stats in
            Task { @MainActor in self?.stats = stats }
        }, onSession: { [weak self] control in
            Task { @MainActor in self?.sessionChanged(control) }
        })
        self.connection = connection
        Task { await connection.start() }
        heartbeat = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.sendStatus("heartbeat") }
        }
    }

    public func disconnect() {
        stopCapture()
        heartbeat?.invalidate()
        heartbeat = nil
        if let connection { Task { await connection.stop() } }
        connection = nil
    }

    /// nil: the server has no session for this device (the connection keeps re-joining).
    private func sessionChanged(_ control: SessionControl?) {
        guard let control else {
            session = nil
            stopCapture()
            return
        }
        session = control
        sendStatus("online")
        if control.state == "running" { startCapture() } else { stopCapture() }
    }

    // MARK: - permissions

    public func requestPermissions() async {
        #if canImport(AVFoundation) && canImport(Vision)
        _ = await CameraPoseCapture.requestAccess()
        #endif
        #if os(iOS)
        _ = await AVAudioApplication.requestRecordPermission()
        #elseif canImport(AVFoundation)
        _ = await AVCaptureDevice.requestAccess(for: .audio)
        #endif
        #if canImport(Speech) && canImport(AVFoundation)
        _ = await SpeechCapture.requestAuthorization()
        #endif
        refreshSpeechStatus()
    }

    public func refreshSpeechStatus() {
        #if canImport(Speech) && canImport(AVFoundation)
        let availability = SpeechCapture.availability(language: language)
        speechStatus = availability.usable ? "on-device \(language) ready" : (availability.reason ?? "unavailable")
        #else
        speechStatus = "Speech framework unavailable on this platform"
        #endif
    }

    // MARK: - capture

    public func startCapture() {
        guard !capturing, let session, session.state != "ended" else { return }
        capturing = true
        #if canImport(UIKit) && os(iOS)
        UIApplication.shared.isIdleTimerDisabled = true      // hands-off practice must not auto-lock the phone
        #endif
        #if canImport(AVFoundation) && canImport(Vision)
        let preference = PoseEstimator.Preference(rawValue: posePreference) ?? .prefer3D
        let rate = session.poseRateHz > 0 ? min(poseRateHz, session.poseRateHz) : poseRateHz   // server rate is advisory upper bound
        let camera = CameraPoseCapture(targetRateHz: rate,
                                       preference: preference, onFrame: { [weak self] payload, captured, fallback in
            Task { @MainActor in self?.poseFrame(payload, captured, fallback: fallback) }
        }, onStatus: { [weak self] status, reason in
            Task { @MainActor in self?.sendStatus(status, reason: reason) }
        })
        do {
            try camera.configure(position: .back)
            camera.start()
            self.camera = camera
        } catch {
            message = "Camera unavailable: \(error)"
        }
        #endif
        #if canImport(Speech) && canImport(AVFoundation)
        if speechEnabled && session.micSource == kind {
            let speech = SpeechCapture(language: session.language, onTranscript: { [weak self] payload, isFinal, captured in
                Task { @MainActor in
                    self?.send(isFinal ? .transcriptFinal : .transcriptPartial, .transcript(payload), at: captured)
                }
            }, onActivity: { [weak self] payload, captured in
                Task { @MainActor in self?.send(.speechActivity, .speechActivity(payload), at: captured) }
            })
            do {
                try speech.start()                             // microphone + VAD; transcription if available
                self.speech = speech
                if let reason = speech.transcriptionUnavailableReason {
                    speechStatus = "VAD only, no transcription: \(reason)"   // reported honestly; no cloud fallback
                    send(.systemWarning, .warning(SystemWarningPayload(code: "transcription_unavailable",
                                                                       message: String(speechStatus.prefix(500)))), at: Date())
                } else {
                    speechStatus = "on-device \(session.language) transcription + VAD"
                }
            } catch {
                speechStatus = error.localizedDescription
                send(.systemWarning, .warning(SystemWarningPayload(code: "microphone_unavailable",
                                                                   message: String(speechStatus.prefix(500)))), at: Date())
            }
        }
        #endif
        sendStatus("online")
    }

    public func stopCapture() {
        guard capturing else { return }
        capturing = false
        #if canImport(UIKit) && os(iOS)
        UIApplication.shared.isIdleTimerDisabled = false
        #endif
        #if canImport(AVFoundation) && canImport(Vision)
        camera?.stop()
        camera = nil
        #endif
        #if canImport(Speech) && canImport(AVFoundation)
        speech?.stop()
        speech = nil
        #endif
        poseMode = "off"
    }

    private func poseFrame(_ payload: PoseFramePayload, _ captured: Date, fallback: String?) {
        poseMode = payload.mode
        lastInferenceMs = payload.inferenceMs
        poseFallback = fallback
        send(.poseFrame, .pose(payload), at: captured)
    }

    // MARK: - Watch relay

    private func relayHeart(_ payloads: [HeartRateSamplePayload]) {
        let watchId = WatchBridge.watchDeviceId(relayDeviceId: deviceId)
        let source = SourceInfo(deviceId: watchId, kind: "watch", simulated: false, relayDeviceId: deviceId)
        for payload in payloads {
            watchStatus.lastSampleAge = Date().timeIntervalSince(payload.measuredAt)
            enqueue(OutgoingEvent(sessionId: activeSessionId, source: source, eventType: .heartRateSample,
                                  capturedAt: payload.measuredAt, payload: .heartRate(payload), sourceMonotonicMs: nil))
        }
    }

    /// Samples arriving through HealthKit workout mirroring (iOS 17+) are labelled "direct".
    public func handleMirrored(_ message: WatchLink.Message) {
        watch?.handle(message, delivery: "direct")
    }

    private func watchChanged(_ state: WatchState) {
        let changed = state.reachable != watchStatus.reachable || state.authorized != watchStatus.authorized
        watchStatus = state
        if changed { sendStatus("heartbeat", reason: state.reachable ? "watch reachable" : "watch unreachable") }
    }

    // MARK: - sending

    private func sendStatus(_ status: String, reason: String? = nil) {
        var payload = DeviceStatusPayload(status: status, reason: reason)
        payload.appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        payload.osVersion = ProcessInfo.processInfo.operatingSystemVersionString
        payload.poseMode = capturing ? poseMode : "off"
        payload.poseRateHz = poseRateHz
        payload.speech = ["status": .string(speechStatus), "language": .string(language)]
        payload.watch = ["supported": .bool(watchStatus.supported), "paired": .bool(watchStatus.paired),
                         "reachable": .bool(watchStatus.reachable),
                         "authorized": watchStatus.authorized.map(JSONValue.bool) ?? .null,
                         "collection_mode": .string(watchStatus.collectionMode)]
        switch ProcessInfo.processInfo.thermalState {
        case .nominal: payload.thermalState = "nominal"
        case .fair: payload.thermalState = "fair"
        case .serious: payload.thermalState = "serious"
        case .critical: payload.thermalState = "critical"
        @unknown default: payload.thermalState = nil
        }
        send(.deviceStatus, .deviceStatus(payload), at: Date())
    }

    /// Empty when there is no live session: the connection stamps the next joined session's id.
    private var activeSessionId: String {
        guard let session, session.state != "ended" else { return "" }
        return session.sessionId
    }

    private func send(_ type: EventType, _ payload: EventPayload, at captured: Date) {
        let source = SourceInfo(deviceId: deviceId, kind: kind)
        enqueue(OutgoingEvent(sessionId: activeSessionId, source: source, eventType: type, capturedAt: captured,
                              payload: payload))
    }

    private func enqueue(_ event: OutgoingEvent) {
        guard let connection else { return }
        Task { await connection.enqueue(event) }
    }
}

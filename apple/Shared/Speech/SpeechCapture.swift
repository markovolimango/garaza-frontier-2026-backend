#if canImport(Speech) && canImport(AVFoundation)
import AVFoundation
import CoachWire
import Foundation
import QuartzCore
import Speech

/// Microphone capture with energy VAD and optional on-device transcription (SFSpeechRecognizer).
///
/// - The microphone and the VAD (speech.activity) run whenever microphone access is granted.
///   Transcription is optional: if the language has no on-device recognizer (e.g. sr-RS) or speech
///   permission is missing, `start()` still succeeds and `transcriptionUnavailableReason` says why.
///   It never falls back to server recognition.
/// - Recognition requests are rotated every `rotationSeconds` without a gap: the next request is
///   started before the old one is ended. A failing recognizer is restarted with exponential
///   backoff that resets after a result.
/// - Partial results carry increasing revisions of one utterance id. Segment confidence is sent
///   only for final results where the recognizer provides it. Raw audio is never stored or sent.
///
/// Threads: the audio tap runs on the render thread (VAD state is confined to it); recognizer
/// callbacks, rotations and restarts run on the main queue. Shared state is guarded by `lock`.
public final class SpeechCapture: @unchecked Sendable {
    public struct Availability: Codable, Equatable, Sendable {
        public var locale: String
        public var authorization: String
        public var recognizerAvailable: Bool
        public var onDeviceSupported: Bool
        public var usable: Bool
        public var reason: String?
    }

    public enum CaptureError: Error, LocalizedError {
        case microphone(String)
        public var errorDescription: String? { if case .microphone(let r) = self { return r }; return nil }
    }

    public typealias TranscriptHandler = @Sendable (TranscriptPayload, _ isFinal: Bool, _ capturedAt: Date) -> Void
    public typealias ActivityHandler = @Sendable (SpeechActivityPayload, _ capturedAt: Date) -> Void

    /// One recognition request/task; fields are guarded by SpeechCapture.lock.
    private final class Utterance: @unchecked Sendable {
        let id = "utt-" + UUID().uuidString.lowercased().prefix(12)
        let request = SFSpeechAudioBufferRecognitionRequest()
        let startedAt = ProcessInfo.processInfo.systemUptime
        var task: SFSpeechRecognitionTask?
        var revision = 0
        var audioStart: Date?
        var receivedResult = false
    }

    static let rotationSeconds: TimeInterval = 50       // recognizers limit request length

    public let locale: Locale
    private let engine = AVAudioEngine()
    private let onTranscript: TranscriptHandler
    private let onActivity: ActivityHandler
    private let lock = NSLock()
    private var recognizer: SFSpeechRecognizer?
    private var current: Utterance?
    private var finishing: [Utterance] = []
    private var running = false
    private var rotationScheduled = false
    private var restartBackoff = Backoff(initial: 0.5, maximum: 15)
    private var unavailableReason: String?
    private var vad = EnergyVAD()                         // audio thread only

    public init(language: String, onTranscript: @escaping TranscriptHandler, onActivity: @escaping ActivityHandler) {
        self.locale = Locale(identifier: language)
        self.onTranscript = onTranscript
        self.onActivity = onActivity
    }

    /// Why transcription is off while the microphone and VAD run (nil = transcribing).
    public var transcriptionUnavailableReason: String? {
        lock.lock(); defer { lock.unlock() }
        return unavailableReason
    }

    /// Availability without prompting the user.
    public static func availability(language: String) -> Availability {
        let status = SFSpeechRecognizer.authorizationStatus()
        let auth: String = {
            switch status {
            case .authorized: return "authorized"
            case .denied: return "denied"
            case .restricted: return "restricted"
            case .notDetermined: return "not_determined"
            @unknown default: return "unknown"
            }
        }()
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else {
            return Availability(locale: language, authorization: auth, recognizerAvailable: false, onDeviceSupported: false,
                                usable: false, reason: "No speech recognizer for \(language) on this device (language unsupported).")
        }
        let onDevice = recognizer.supportsOnDeviceRecognition
        var reason: String?
        if !onDevice { reason = "On-device recognition is not supported for \(language); cloud recognition is not used." }
        else if !recognizer.isAvailable { reason = "Recognizer for \(language) is currently unavailable." }
        else if status != .authorized { reason = "Speech recognition permission: \(auth)." }
        return Availability(locale: language, authorization: auth, recognizerAvailable: recognizer.isAvailable,
                            onDeviceSupported: onDevice, usable: reason == nil, reason: reason)
    }

    public static func requestAuthorization() async -> Bool {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0 == .authorized) }
        }
    }

    /// Throws `CaptureError.microphone` unless microphone access is granted (checked before the
    /// audio tap is installed; a tap on an input without permission has no valid format).
    public static func checkMicrophone() throws {
        #if os(iOS)
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return
        case .denied:
            throw CaptureError.microphone("Microphone access is denied. Allow it in Settings > Privacy & Security > Microphone.")
        case .undetermined:
            throw CaptureError.microphone("Microphone access was not requested yet. Tap \"Request camera, microphone and speech access\".")
        @unknown default:
            throw CaptureError.microphone("Microphone permission state is unknown.")
        }
        #elseif os(macOS)
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return
        case .notDetermined:
            throw CaptureError.microphone("Microphone access was not requested yet.")
        default:
            throw CaptureError.microphone("Microphone access is denied (System Settings > Privacy & Security > Microphone).")
        }
        #endif
    }

    /// Starts the microphone and VAD; starts transcription too when it is usable. Call on the main thread.
    public func start() throws {
        try Self.checkMicrophone()
        let availability = Self.availability(language: locale.identifier)
        #if os(iOS)
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetooth])
        try audio.setActive(true, options: .notifyOthersOnDeactivation)
        #endif
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw CaptureError.microphone("The microphone delivers no audio (sample rate \(format.sampleRate), "
                                          + "\(format.channelCount) channels). Check microphone access.")
        }
        lock.lock()
        running = true
        restartBackoff.reset()
        if availability.usable, let recognizer = SFSpeechRecognizer(locale: locale) {
            self.recognizer = recognizer
            unavailableReason = nil
            current = beginUtteranceLocked()
        } else {
            unavailableReason = availability.reason ?? "transcription unavailable"
        }
        lock.unlock()
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, when in
            self?.handle(buffer: buffer, when: when)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            stop()
            throw error
        }
    }

    public func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        running = false
        let utterances = [current].compactMap { $0 } + finishing
        let tasks = utterances.compactMap(\.task)
        current = nil
        finishing.removeAll()
        lock.unlock()
        utterances.forEach { $0.request.endAudio() }
        tasks.forEach { $0.cancel() }
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }

    // MARK: - recognition (main queue)

    private func beginUtteranceLocked() -> Utterance? {
        guard running, let recognizer else { return nil }
        let utterance = Utterance()
        utterance.request.requiresOnDeviceRecognition = true   // honoured because supportsOnDeviceRecognition was checked
        utterance.request.shouldReportPartialResults = true
        utterance.request.addsPunctuation = true
        // The result handler runs on recognizer.queue (main), never synchronously inside this call.
        utterance.task = recognizer.recognitionTask(with: utterance.request) { [weak self, weak utterance] result, error in
            guard let self, let utterance else { return }
            self.recognized(utterance, result: result, error: error)
        }
        return utterance
    }

    private func recognized(_ utterance: Utterance, result: SFSpeechRecognitionResult?, error: Error?) {
        if let result { emit(result, from: utterance) }
        guard error != nil || result?.isFinal == true else { return }
        lock.lock()
        utterance.task = nil
        finishing.removeAll { $0 === utterance }
        guard running, current === utterance else { lock.unlock(); return }   // a rotated request finished
        current = nil
        // A task that produced results or ran a while was healthy: restart at once. One that failed
        // immediately (e.g. dictation disabled) is retried with growing delays instead of spinning.
        let healthy = utterance.receivedResult || ProcessInfo.processInfo.systemUptime - utterance.startedAt >= 5
        if healthy { restartBackoff.reset() }
        let delay = healthy ? 0 : restartBackoff.next()
        lock.unlock()
        if delay == 0 {
            restartTranscription()
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.restartTranscription() }
        }
    }

    private func restartTranscription() {
        lock.lock(); defer { lock.unlock() }
        guard running, current == nil else { return }
        current = beginUtteranceLocked()
    }

    /// Starts the next request before ending the current one, so no audio falls between them.
    private func rotate() {
        lock.lock()
        rotationScheduled = false
        guard running, let old = current, let next = beginUtteranceLocked() else { lock.unlock(); return }
        current = next
        finishing.append(old)
        lock.unlock()
        old.request.endAudio()
    }

    private func emit(_ result: SFSpeechRecognitionResult, from utterance: Utterance) {
        lock.lock()
        utterance.revision += 1
        utterance.receivedResult = true
        if utterance === current { restartBackoff.reset() }
        let revision = utterance.revision
        let start = utterance.audioStart
        lock.unlock()
        let isFinal = result.isFinal
        let segments = result.bestTranscription.segments.map { segment in
            TranscriptSegment(text: segment.substring, startS: segment.timestamp, durationS: segment.duration,
                              confidence: isFinal && segment.confidence > 0 ? Double(segment.confidence) : nil)
        }
        let payload = TranscriptPayload(utteranceId: utterance.id, revision: revision,
                                        text: result.bestTranscription.formattedString, language: locale.identifier,
                                        onDevice: true, audioStartAt: start, segments: segments)
        onTranscript(payload, isFinal, Date())
    }

    // MARK: - audio (render thread)

    private func handle(buffer: AVAudioPCMBuffer, when: AVAudioTime) {
        let wall = Self.wallClock(of: when)
        let duration = Double(buffer.frameLength) / buffer.format.sampleRate
        var scheduleRotation = false
        lock.lock()
        if let utterance = current {
            if utterance.audioStart == nil { utterance.audioStart = wall }
            utterance.request.append(buffer)
            if !rotationScheduled, ProcessInfo.processInfo.systemUptime - utterance.startedAt > Self.rotationSeconds {
                rotationScheduled = true
                scheduleRotation = true
            }
        }
        lock.unlock()
        if scheduleRotation { DispatchQueue.main.async { [weak self] in self?.rotate() } }
        if let channel = buffer.floatChannelData?[0] {
            let level = EnergyVAD.levelDbfs(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
            for (payload, at) in vad.process(levelDb: level, duration: duration, at: wall) {
                onActivity(payload, at)
            }
        }
    }

    static func wallClock(of time: AVAudioTime) -> Date {
        guard time.isHostTimeValid else { return Date() }
        let age = CACurrentMediaTime() - AVAudioTime.seconds(forHostTime: time.hostTime)
        return Date().addingTimeInterval(-max(0, age))
    }
}
#endif

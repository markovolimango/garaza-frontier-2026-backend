#if canImport(AVFAudio)
import AVFAudio
import Foundation

/// Speech synthesis through AVSpeechSynthesizer.
///
/// The synthesizer is a stored property: the system does not retain it, so it must live until
/// speech concludes. Voices are enumerated at runtime; a Serbian voice is never assumed.
/// Queue: at most one utterance speaking and one pending; a newer request replaces the pending one.
// @unchecked Sendable: mutable state is guarded by `lock`; AVSpeechSynthesizer is only touched through it and the delegate.
public final class SpeechSynthesisService: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    public struct Voice: Codable, Equatable, Sendable {
        public let identifier: String
        public let name: String
        public let language: String
        public let quality: String
    }

    public struct Result: Codable, Equatable, Sendable {
        public let state: String        // finished | interrupted | skipped
        public let voice: String?
        public let reason: String?
    }

    private let synthesizer = AVSpeechSynthesizer()
    private var continuations: [ObjectIdentifier: CheckedContinuation<Result, Never>] = [:]
    private var voiceNames: [ObjectIdentifier: String] = [:]
    private var pending: (text: String, language: String, continuation: CheckedContinuation<Result, Never>)?
    private let lock = NSLock()

    public override init() {
        super.init()
        synthesizer.delegate = self
    }

    public static func voices(language prefix: String? = nil) -> [Voice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { prefix == nil || $0.language.lowercased().hasPrefix(prefix!.lowercased()) }
            .map { voice in
                let quality: String
                switch voice.quality {
                case .enhanced: quality = "enhanced"
                case .premium: quality = "premium"
                default: quality = "default"
                }
                return Voice(identifier: voice.identifier, name: voice.name, language: voice.language, quality: quality)
            }
    }

    public static func bestVoice(for language: String) -> AVSpeechSynthesisVoice? {
        let primary = String(language.split(separator: "-").first ?? Substring(language)).lowercased()
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.lowercased() == language.lowercased() || $0.language.lowercased().hasPrefix(primary + "-")
        }
        return candidates.max { $0.quality.rawValue < $1.quality.rawValue }
    }

    public var isSpeaking: Bool { synthesizer.isSpeaking }

    /// Speak and wait for the outcome. Unsupported languages are skipped, not spoken with a wrong voice.
    public func speak(_ text: String, language: String) async -> Result {
        guard let voice = Self.bestVoice(for: language) else {
            return Result(state: "skipped", voice: nil, reason: "no installed voice for \(language)")
        }
        return await withCheckedContinuation { continuation in
            lock.lock()
            if synthesizer.isSpeaking {
                if let old = pending { old.continuation.resume(returning: Result(state: "skipped", voice: nil, reason: "replaced by a newer suggestion")) }
                pending = (text, language, continuation)
                lock.unlock()
                return
            }
            lock.unlock()
            start(text, voice: voice, continuation: continuation)
        }
    }

    public func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    /// Render without playing (checks synthesis works, e.g. in automated tests). Returns rendered seconds.
    public func renderSilently(_ text: String, language: String) async -> Double? {
        guard let voice = Self.bestVoice(for: language) else { return nil }
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        return await withCheckedContinuation { continuation in
            var frames: AVAudioFramePosition = 0
            var rate = 0.0
            var done = false
            synthesizer.write(utterance) { buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 {
                    if !done { done = true; continuation.resume(returning: rate > 0 ? Double(frames) / rate : 0) }
                    return
                }
                frames += AVAudioFramePosition(pcm.frameLength)
                rate = pcm.format.sampleRate
            }
        }
    }

    private func start(_ text: String, voice: AVSpeechSynthesisVoice, continuation: CheckedContinuation<Result, Never>) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        lock.lock()
        continuations[ObjectIdentifier(utterance)] = continuation
        voiceNames[ObjectIdentifier(utterance)] = voice.identifier
        lock.unlock()
        synthesizer.speak(utterance)
    }

    private func finish(_ utterance: AVSpeechUtterance, state: String) {
        lock.lock()
        let key = ObjectIdentifier(utterance)
        let continuation = continuations.removeValue(forKey: key)
        let voice = voiceNames.removeValue(forKey: key)
        let next = pending
        pending = nil
        lock.unlock()
        continuation?.resume(returning: Result(state: state, voice: voice, reason: nil))
        if let next {
            if let voice = Self.bestVoice(for: next.language) {
                start(next.text, voice: voice, continuation: next.continuation)
            } else {
                next.continuation.resume(returning: Result(state: "skipped", voice: nil, reason: "no voice"))
            }
        }
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish(utterance, state: "finished")
    }

    public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        finish(utterance, state: "interrupted")
    }
}
#endif

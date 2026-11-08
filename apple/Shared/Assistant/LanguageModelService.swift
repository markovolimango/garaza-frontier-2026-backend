import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Optional Apple Foundation Models adapter (macOS / iOS 26+, Apple Intelligence devices only).
///
/// Used only to rephrase observations that were already computed, or to summarize session facts.
/// It never receives raw frames or audio and must not add numbers, claims about emotions, or
/// medical statements (the backend re-checks every output and falls back to templates).
/// Availability and language support are checked at runtime; Swift availability alone proves nothing.
public enum LanguageModelService {
    public struct Status: Codable, Equatable, Sendable {
        public var frameworkPresent: Bool
        public var available: Bool
        public var reason: String?
        public var supportedLanguages: [String]
        public var supportsLocale: [String: Bool]
    }

    public enum ServiceError: Error, LocalizedError {
        case unavailable(String), unsupportedLanguage(String), timeout, emptyResult
        public var errorDescription: String? {
            switch self {
            case .unavailable(let r): return "Foundation Models unavailable: \(r)"
            case .unsupportedLanguage(let l): return "Foundation Models does not support language '\(l)'"
            case .timeout: return "Foundation Models timed out"
            case .emptyResult: return "Foundation Models returned no text"
            }
        }
    }

    public static func status(checking languages: [String] = ["en", "sr"]) -> Status {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, visionOS 26.0, *) {
            let model = SystemLanguageModel.default
            var reason: String?
            var available = false
            switch model.availability {
            case .available: available = true
            case .unavailable(.deviceNotEligible): reason = "device not eligible for Apple Intelligence"
            case .unavailable(.appleIntelligenceNotEnabled): reason = "Apple Intelligence is not enabled in Settings"
            case .unavailable(.modelNotReady): reason = "model not ready (still downloading or preparing)"
            case .unavailable(let other): reason = "unavailable: \(other)"
            }
            let supported = model.supportedLanguages.map { $0.maximalIdentifier }.sorted()
            var supports: [String: Bool] = [:]
            for language in languages { supports[language] = model.supportsLocale(Locale(identifier: language)) }
            return Status(frameworkPresent: true, available: available, reason: reason, supportedLanguages: supported,
                          supportsLocale: supports)
        }
        return Status(frameworkPresent: true, available: false, reason: "requires macOS/iOS 26", supportedLanguages: [],
                      supportsLocale: [:])
        #else
        return Status(frameworkPresent: false, available: false, reason: "FoundationModels framework not in this SDK",
                      supportedLanguages: [], supportsLocale: [:])
        #endif
    }

    static let instructions = """
    You rephrase short presentation-practice coaching notes. Keep the meaning and every number exactly. \
    Do not add facts, numbers, praise, or interpretations. Never mention emotions, nervousness, stress, \
    anxiety, health or medical topics. Reply in the requested language, in at most the requested number of words.
    """

    public static func rephrase(observation: String, action: String, language: String, maxWords: Int,
                                timeout: TimeInterval = 4) async throws -> String {
        let prompt = "Language: \(language). Maximum words: \(maxWords). Observation: \(observation) Suggested action: \(action)"
        return try await generate(prompt: prompt, language: language, timeout: timeout)
    }

    public static func summarize(facts: [String], language: String, maxWords: Int,
                                 timeout: TimeInterval = 8) async throws -> String {
        let prompt = "Language: \(language). Maximum words: \(maxWords). Summarize these practice-session facts " +
            "neutrally, without judging the speaker: " + facts.joined(separator: " ")
        return try await generate(prompt: prompt, language: language, timeout: timeout)
    }

    /// Loads model resources ahead of the first request (first requests are otherwise slow).
    public static func prewarm() {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, visionOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else { return }
            LanguageModelSession(instructions: instructions).prewarm()
        }
        #endif
    }

    static func generate(prompt: String, language: String, timeout: TimeInterval) async throws -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, iOS 26.0, visionOS 26.0, *) {
            let model = SystemLanguageModel.default
            guard case .available = model.availability else {
                throw ServiceError.unavailable(status().reason ?? "unavailable")
            }
            guard model.supportsLocale(Locale(identifier: language)) else { throw ServiceError.unsupportedLanguage(language) }
            // Structured (guided) generation with a dynamic schema: { "text": String }.
            let root = DynamicGenerationSchema(name: "CoachText", description: "Rephrased text",
                                               properties: [.init(name: "text", description: "The text only",
                                                                  schema: DynamicGenerationSchema(type: String.self))])
            let schema = try GenerationSchema(root: root, dependencies: [])
            let session = LanguageModelSession(model: model, instructions: instructions)
            return try await withTimeout(seconds: timeout) {
                let response = try await session.respond(to: prompt, schema: schema,
                                                         options: GenerationOptions(temperature: 0.2))
                let text = try response.content.value(String.self, forProperty: "text")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { throw ServiceError.emptyResult }
                return text
            }
        }
        #endif
        throw ServiceError.unavailable(status().reason ?? "unavailable")
    }
}


/// Returns the operation's result or throws `timeout` after `seconds`, without waiting for a slow,
/// non-cooperative operation to finish (it is cancelled and its late result is ignored).
func withTimeout<T: Sendable>(seconds: TimeInterval, _ operation: @escaping @Sendable () async throws -> T) async throws -> T {
    let once = ResumeOnce()
    return try await withCheckedThrowingContinuation { continuation in
        let work = Task {
            do {
                let value = try await operation()
                if once.claim() { continuation.resume(returning: value) }
            } catch {
                if once.claim() { continuation.resume(throwing: error) }
            }
        }
        Task {
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            if once.claim() {
                work.cancel()
                continuation.resume(throwing: LanguageModelService.ServiceError.timeout)
            }
        }
    }
}

/// Ensures a continuation is resumed exactly once.
final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool { lock.lock(); defer { lock.unlock() }; if done { return false }; done = true; return true }
}

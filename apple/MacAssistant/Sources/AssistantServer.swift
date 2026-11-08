import CoachAssistantKit
import Foundation
import Network
import Security

extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return encoder
    }
}

struct AssistantStatus: Codable {
    struct TTS: Codable {
        let available: Bool
        let voices: Int
        let languages: [String]
        let serbianVoices: [String]
        let note: String
        enum CodingKeys: String, CodingKey { case available, voices, languages, serbianVoices = "serbian_voices", note }
    }
    let tts: TTS
    let foundationModels: LanguageModelService.Status
    let os: String
    enum CodingKeys: String, CodingKey { case tts, foundationModels = "foundation_models", os }

    static func current() -> AssistantStatus {
        let voices = SpeechSynthesisService.voices()
        let languages = Array(Set(voices.map(\.language))).sorted()
        let serbian = voices.filter { $0.language.lowercased().hasPrefix("sr") }.map { "\($0.name) (\($0.language))" }
        return AssistantStatus(
            tts: TTS(available: !voices.isEmpty, voices: voices.count, languages: languages, serbianVoices: serbian,
                     note: serbian.isEmpty ? "No Serbian voice installed; Serbian text is not spoken with another language's voice." : ""),
            foundationModels: LanguageModelService.status(checking: ["en", "sr"]),
            os: ProcessInfo.processInfo.operatingSystemVersionString)
    }
}

enum TokenFile {
    static func loadOrCreate(path: String) throws -> String {
        if let existing = try? String(contentsOfFile: path, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           !existing.isEmpty {
            return existing
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NSError(domain: "MacAssistant", code: 1, userInfo: [NSLocalizedDescriptionKey: "no secure random"])
        }
        let token = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path, contents: Data((token + "\n").utf8), attributes: [.posixPermissions: 0o600])
        return token
    }
}

/// Tiny HTTP/1.1 server (one request per connection) bound to the loopback interface.
///
/// Limits: 16 KiB of headers and 64 KiB of body (HTTPRequest.parse), the whole request must arrive
/// within `requestTimeout`, and at most `maxConnections` connections are open at once. Malformed
/// requests get a 4xx/5xx answer before authentication; everything else needs the bearer token.
/// Concurrency: `listener` and `open` are only touched on `queue`.
final class AssistantServer: @unchecked Sendable {
    static let requestTimeout: TimeInterval = 10
    static let maxConnections = 32

    private let port: UInt16
    private let token: String
    private let silent: Bool
    private var listener: NWListener?
    private var open = 0
    private let queue = DispatchQueue(label: "coach.assistant.http")
    private let speech = SpeechSynthesisService()

    /// Per-connection flags, only touched on `queue`.
    private final class Exchange: @unchecked Sendable {
        var responding = false
        var closed = false
    }

    init(port: UInt16, token: String, silent: Bool) {
        self.port = port
        self.token = token
        self.silent = silent
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        queue.sync { self.listener = listener }
        listener.start(queue: queue)
    }

    private func accept(_ connection: NWConnection) {
        guard open < Self.maxConnections else {
            connection.cancel()
            return
        }
        open += 1
        let exchange = Exchange()
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                guard let self, !exchange.closed else { return }
                exchange.closed = true
                self.open -= 1
            default:
                break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + Self.requestTimeout) { [weak self] in
            guard let self, !exchange.responding, !exchange.closed else { return }
            exchange.responding = true
            self.send(connection, status: 408, body: Self.error("request_timeout", "request not received in time"))
        }
        receive(connection, exchange, buffer: Data())
    }

    private func receive(_ connection: NWConnection, _ exchange: Exchange, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, complete, error in
            guard let self, !exchange.responding else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if error != nil {
                connection.cancel()
                return
            }
            switch HTTPRequest.parse(buffer) {
            case .complete(let request):
                exchange.responding = true
                Task { await self.respond(connection, request) }
            case .invalid(let status, let reason):
                exchange.responding = true
                self.send(connection, status: status, body: Self.error("invalid_request", reason))
            case .incomplete:
                if complete { connection.cancel() } else { self.receive(connection, exchange, buffer: buffer) }
            }
        }
    }

    private func respond(_ connection: NWConnection, _ request: HTTPRequest) async {
        let (status, body) = await route(request)
        send(connection, status: status, body: body)
    }

    private func send(_ connection: NWConnection, status: Int, body: Data) {
        let header = "HTTP/1.1 \(status) \(HTTPRequest.reasonPhrase(status))\r\nContent-Type: application/json\r\n" +
            "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(header.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func route(_ request: HTTPRequest) async -> (Int, Data) {
        guard request.headers["authorization"] == "Bearer \(token)" else {
            return (401, Self.error("unauthorized", "missing or wrong bearer token"))
        }
        switch (request.method, request.path) {
        case ("GET", "/v1/status"):
            return (200, (try? JSONEncoder.pretty.encode(AssistantStatus.current())) ?? Data())
        case ("GET", "/v1/tts/voices"):
            return (200, (try? JSONEncoder().encode(["voices": SpeechSynthesisService.voices()])) ?? Data())
        case ("POST", "/v1/tts/speak"):
            guard let body = request.json, let text = body["text"] as? String, let language = body["language"] as? String
            else { return (400, Self.error("invalid_request", "text and language required")) }
            if silent {
                let seconds = await speech.renderSilently(text, language: language)
                return (200, Self.json(["state": seconds == nil ? "skipped" : "finished", "rendered_seconds": seconds as Any,
                                        "mode": "silent"]))
            }
            let result = await speech.speak(text, language: language)
            return (200, (try? JSONEncoder().encode(result)) ?? Data())
        case ("POST", "/v1/fm/rephrase"):
            guard let body = request.json, let observation = body["observation"] as? String,
                  let action = body["suggested_action"] as? String, let language = body["language"] as? String
            else { return (400, Self.error("invalid_request", "observation, suggested_action, language required")) }
            do {
                let text = try await LanguageModelService.rephrase(observation: observation, action: action, language: language,
                                                                   maxWords: body["max_words"] as? Int ?? 25,
                                                                   timeout: min(30, body["timeout_s"] as? Double ?? 6))
                return (200, Self.json(["text": text, "source": "foundation_models"]))
            } catch {
                return (503, Self.error("foundation_models_unavailable", error.localizedDescription))
            }
        case ("POST", "/v1/fm/summarize"):
            guard let body = request.json, let facts = body["facts"] as? [String], let language = body["language"] as? String
            else { return (400, Self.error("invalid_request", "facts and language required")) }
            do {
                let text = try await LanguageModelService.summarize(facts: facts, language: language,
                                                                    maxWords: body["max_words"] as? Int ?? 80,
                                                                    timeout: min(30, body["timeout_s"] as? Double ?? 10))
                return (200, Self.json(["text": text, "source": "foundation_models"]))
            } catch {
                return (503, Self.error("foundation_models_unavailable", error.localizedDescription))
            }
        default:
            return (404, Self.error("not_found", "\(request.method) \(request.path)"))
        }
    }

    static func json(_ object: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object.mapValues { $0 is NSNull ? NSNull() : $0 })) ?? Data()
    }

    static func error(_ code: String, _ message: String) -> Data {
        json(["error": ["code": code, "message": message]])
    }
}

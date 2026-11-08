import Foundation

/// Minimal HTTP/1.1 request parsing for the loopback MacAssistant (one request per connection).
///
/// Strict on purpose: a well-formed request line, header lines with a name, at most
/// `maxHeaderBytes` of headers, a decimal Content-Length (no sign) of at most `maxBodyBytes`, and
/// no Transfer-Encoding. Anything else is rejected with a status before any range arithmetic.
public struct HTTPRequest: Sendable {
    public let method: String
    public let path: String
    public let headers: [String: String]
    public let body: Data

    public enum Parse: Sendable {
        case incomplete
        case complete(HTTPRequest)
        case invalid(status: Int, reason: String)
    }

    public static let maxHeaderBytes = 16 * 1024
    public static let maxBodyBytes = 64 * 1024
    private static let terminator = Data("\r\n\r\n".utf8)

    public var json: [String: Any]? { try? JSONSerialization.jsonObject(with: body) as? [String: Any] }

    public static func parse(_ data: Data) -> Parse {
        guard let range = data.range(of: terminator) else {
            return data.count > maxHeaderBytes ? .invalid(status: 431, reason: "request headers too large") : .incomplete
        }
        guard data.distance(from: data.startIndex, to: range.lowerBound) <= maxHeaderBytes else {
            return .invalid(status: 431, reason: "request headers too large")
        }
        guard let head = String(data: data[data.startIndex..<range.lowerBound], encoding: .utf8) else {
            return .invalid(status: 400, reason: "request headers are not UTF-8")
        }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard parts.count == 3, !parts[0].isEmpty, parts[0].allSatisfy({ $0.isASCII && $0.isUppercase }),
              parts[1].hasPrefix("/"), parts[2].hasPrefix("HTTP/1.") else {
            return .invalid(status: 400, reason: "malformed request line")
        }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), colon != line.startIndex else {
                return .invalid(status: 400, reason: "malformed header line")
            }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if let existing = headers[name] {
                if existing != value, name == "content-length" || name == "authorization" {
                    return .invalid(status: 400, reason: "conflicting \(name) headers")
                }
                continue
            }
            headers[name] = value
        }
        if headers["transfer-encoding"] != nil {
            return .invalid(status: 501, reason: "Transfer-Encoding is not supported; send Content-Length")
        }
        var length = 0
        if let raw = headers["content-length"] {
            guard !raw.isEmpty, raw.count <= 9, raw.allSatisfy({ $0.isASCII && $0.isNumber }), let value = Int(raw) else {
                return .invalid(status: 400, reason: "invalid Content-Length")
            }
            guard value <= maxBodyBytes else {
                return .invalid(status: 413, reason: "body larger than \(maxBodyBytes) bytes")
            }
            length = value
        }
        let available = data.distance(from: range.upperBound, to: data.endIndex)
        guard available >= length else { return .incomplete }
        let bodyEnd = data.index(range.upperBound, offsetBy: length)
        let path = String(parts[1]).components(separatedBy: "?").first ?? "/"
        return .complete(HTTPRequest(method: String(parts[0]), path: path, headers: headers,
                                     body: Data(data[range.upperBound..<bodyEnd])))
    }

    public static func reasonPhrase(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 404: return "Not Found"
        case 408: return "Request Timeout"
        case 413: return "Content Too Large"
        case 431: return "Request Header Fields Too Large"
        case 501: return "Not Implemented"
        case 503: return "Service Unavailable"
        default: return "Error"
        }
    }
}

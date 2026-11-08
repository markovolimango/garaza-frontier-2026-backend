import Foundation

/// Human-readable connection diagnostics for the most common physical-device problems.
public enum ConnectionDiagnostics {
    public struct Failure: Error, LocalizedError, Sendable {
        public let message: String
        public init(message: String) { self.message = message }
        public var errorDescription: String? { message }
    }

    public static func explain(_ error: Error, baseURL: URL) -> String {
        let host = baseURL.host ?? "?"
        if host == "localhost" || host == "127.0.0.1" {
            #if os(iOS)
            return "On iPhone, '\(host)' is the iPhone itself. Use the Mac's LAN address or .local name and start the backend with --lan."
            #endif
        }
        guard let url = error as? URLError else { return error.localizedDescription }
        switch url.code {
        case .cannotConnectToHost, .cannotFindHost, .timedOut:
            return "Cannot reach \(host):\(baseURL.port ?? 0). Is the backend running with --lan on the same Wi-Fi? Check the Mac firewall and the iPhone's Local Network permission (Settings > Privacy & Security > Local Network)."
        case .appTransportSecurityRequiresSecureConnection:
            return "App Transport Security blocked a plaintext connection. Use https/wss with the development CA (scripts/make-dev-cert.sh) or a build that declares NSAllowsLocalNetworking."
        case .serverCertificateUntrusted, .serverCertificateHasUnknownRoot, .serverCertificateHasBadDate,
             .serverCertificateNotYetValid, .secureConnectionFailed, .clientCertificateRejected:
            return "TLS failed: install the development CA on the iPhone and enable full trust (Settings > General > About > Certificate Trust Settings); the certificate must contain \(host)."
        case .notConnectedToInternet, .networkConnectionLost:
            return "Network unavailable or lost (\(url.code.rawValue)). Reconnecting automatically."
        case .userAuthenticationRequired, .badServerResponse:
            return "The server refused the connection (token expired or revoked?). Pair the device again."
        default:
            return "\(url.localizedDescription) (URLError \(url.code.rawValue))"
        }
    }
}

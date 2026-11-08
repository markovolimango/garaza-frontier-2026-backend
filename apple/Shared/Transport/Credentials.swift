import Foundation
import Security

/// Device identity (stable per install) and the paired device token in the Keychain.
public enum DeviceIdentity {
    public static func deviceId(prefix: String, defaults: UserDefaults = .standard) -> String {
        let key = "coach.device_id"
        if let existing = defaults.string(forKey: key) { return existing }
        let id = "\(prefix)-" + UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(12)
        defaults.set(id, forKey: key)
        return id
    }
}

public enum TokenStore {
    private static let service = "garaza.coach.device-token"

    public static func save(_ token: String, account: String) -> Bool {
        delete(account: account)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    public static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    public static func delete(account: String) -> Bool {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: account]
        return SecItemDelete(query as CFDictionary) == errSecSuccess
    }
}

/// POST /v1/devices/pair with a single-use code shown by `python -m coach pair`.
public enum Pairing {
    public struct Result: Decodable, Sendable {
        public let deviceId: String
        public let deviceToken: String
        public let expiresAt: String
        enum CodingKeys: String, CodingKey { case deviceId = "device_id", deviceToken = "device_token", expiresAt = "expires_at" }
    }

    public static func pair(baseURL: URL, code: String, deviceId: String, kind: String, name: String?) async throws -> Result {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/devices/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: String?] = ["code": code.replacingOccurrences(of: "-", with: ""), "device_id": deviceId,
                                       "kind": kind, "name": name]
        request.httpBody = try JSONSerialization.data(withJSONObject: body.compactMapValues { $0 })
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 201 else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])
                .flatMap { ($0["error"] as? [String: Any])?["message"] as? String } ?? "HTTP \(status)"
            throw ConnectionDiagnostics.Failure(message: "Pairing failed: \(message)")
        }
        return try JSONDecoder().decode(Result.self, from: data)
    }
}

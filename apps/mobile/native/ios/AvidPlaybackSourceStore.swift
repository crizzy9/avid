import Foundation
import Security

struct AvidStoredAudioSource: Codable {
    let accountScope: String
    let bookId: String
    let fileId: String
    let url: URL
    let title: String
    let author: String
    let rate: Float
    let expiresAt: Date?
    var scopeHash: String { AvidSharedStore.scopeHash(accountScope) }
    var key: String { "\(scopeHash):\(bookId):\(fileId)" }
}

/// Main-app Keychain. The widget extension receives neither URLs nor tokens.
enum AvidPlaybackSourceStore {
    private static let service = "app.avid.native-audio-source"

    static func save(_ source: AvidStoredAudioSource) throws {
        let data = try JSONEncoder().encode(source)
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service, kSecAttrAccount as String: source.key]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var creation = query
            creation[kSecValueData as String] = data
            creation[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(creation as CFDictionary, nil)
            guard added == errSecSuccess else { throw keychainError(added) }
        } else if status != errSecSuccess { throw keychainError(status) }
    }

    static func source(for book: AvidRecentBook) throws -> AvidStoredAudioSource {
        guard book.scopeHash == AvidSharedStore.shared.activeScopeHash else { throw AvidSurfaceError.unavailableBook }
        let key = "\(book.scopeHash):\(book.bookId):\(book.fileId)"
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { throw AvidSurfaceError.noAudioSource }
        let source = try JSONDecoder().decode(AvidStoredAudioSource.self, from: data)
        guard source.scopeHash == book.scopeHash, source.bookId == book.bookId, source.fileId == book.fileId else { throw AvidSurfaceError.unavailableBook }
        if let expires = source.expiresAt, expires <= Date() { throw AvidSurfaceError.expiredSource }
        return source
    }

    static func removeAccount(scopeHash: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecReturnAttributes as String: true, kSecMatchLimit as String: kSecMatchLimitAll]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let items = result as? [[String: Any]] else { return }
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String, account.hasPrefix("\(scopeHash):") else { continue }
            SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: account] as CFDictionary)
        }
    }

    private static func keychainError(_ status: OSStatus) -> Error {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey:
            (SecCopyErrorMessageString(status, nil) as String?) ?? "Native playback recovery could not be stored securely."])
    }
}

import Capacitor
import Foundation
import Security

struct AvidAudioTrack: Codable {
    let id: String
    let url: URL
    let duration: Double?
}

struct AvidAudioChapter: Codable {
    let id: String
    let title: String
    let start: Double
    let duration: Double
    static func validate(_ chapters: [AvidAudioChapter]) -> Bool {
        guard chapters.count <= 10000, Set(chapters.map(\.id)).count == chapters.count else { return false }
        return chapters.enumerated().allSatisfy { index, chapter in
            !chapter.id.isEmpty && chapter.id.utf8.count <= 4096 && chapter.title.utf8.count <= 4096 &&
            chapter.start.isFinite && chapter.start >= 0 && chapter.duration.isFinite && chapter.duration > 0 &&
            (index == 0 || chapter.start >= chapters[index - 1].start + chapters[index - 1].duration)
        }
    }
}

struct AvidStoredAudioSource: Codable {
    let accountScope: String
    let bookId: String
    let fileId: String
    let url: URL
    let tracks: [AvidAudioTrack]?
    let chapters: [AvidAudioChapter]?
    let manifestRevision: String?
    let readOnly: Bool?
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

    @MainActor static func source(for book: AvidRecentBook) throws -> AvidStoredAudioSource {
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
        let tracks = source.tracks ?? [AvidAudioTrack(id: source.fileId, url: source.url, duration: nil)]
        guard tracks.allSatisfy({ !$0.url.isFileURL || AvidMediaStore.shared.owns($0.url, scope: source.accountScope, book: source.bookId, file: source.fileId, track: $0.id) }) else { throw AvidMediaStore.Failure.missing }
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

// Native login credentials are separate from widget metadata and prepared media descriptors.
// A durable tombstone generation prevents old asynchronous refreshes from restoring a logged-out session.
enum AvidSessionStore {
    private static let service = "app.avid.native-session"
    private static var cached: [String: Any]?
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service, kSecAttrAccount as String: "active"]
    static func read() throws -> [String: Any] {
        if let cached { return cached }
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return try save(["generation": UUID().uuidString]) }
        guard status == errSecSuccess, let data = result as? Data,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw AvidSurfaceError.unavailableBook }
        cached = value
        return value
    }
    static func readOnly(scope: String) -> Bool {
        guard let record = try? read(), let session = record["session"] as? [String: Any],
              let profile = session["profile"] as? [String: Any], let raw = profile["url"] as? String,
              let data = scope.data(using: .utf8), let identity = try? JSONSerialization.jsonObject(with: data) as? [String],
              identity.count == 2, identity[1] == session["userId"] as? String else { return true }
        let trimmed = raw.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        let normalized = trimmed.hasSuffix("/api/v1") ? String(trimmed.dropLast(7)) : trimmed
        return identity[0] != normalized || record["readOnly"] as? Bool != false
    }
    static func write(expected: String, session: [String: Any], readOnly: Bool) throws -> [String: Any] {
        guard try read()["generation"] as? String == expected,
              let token = session["accessToken"] as? String, !token.isEmpty,
              let user = session["userId"] as? String, !user.isEmpty,
              let profile = session["profile"] as? [String: Any], let raw = profile["url"] as? String,
              let url = URL(string: raw), ["https", "http"].contains(url.scheme ?? ""), url.host != nil, url.user == nil,
              session.keys.allSatisfy({ ["profile", "userId", "accessToken", "refreshToken", "clientKind"].contains($0) }) else { throw AvidSurfaceError.invalidInput }
        let data = try JSONSerialization.data(withJSONObject: session)
        guard data.count <= 262144 else { throw AvidSurfaceError.invalidInput }
        return try save(["generation": UUID().uuidString, "session": session, "readOnly": readOnly])
    }
    static func clear(expected: String?) throws -> [String: Any] {
        if let expected, try read()["generation"] as? String != expected { throw AvidSurfaceError.invalidInput }
        return try save(["generation": UUID().uuidString])
    }
    private static func save(_ value: [String: Any]) throws -> [String: Any] {
        let data = try JSONSerialization.data(withJSONObject: value)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var creation = query; creation[kSecValueData as String] = data
            creation[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(creation as CFDictionary, nil) == errSecSuccess else { throw AvidSurfaceError.unavailableBook }
        } else if status != errSecSuccess { throw AvidSurfaceError.unavailableBook }
        cached = value
        return value
    }
}

@objc(AvidSessionPlugin)
public class AvidSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidSessionPlugin"
    public let jsName = "AvidSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)]
    private func run(_ call: CAPPluginCall, action: @escaping () throws -> [String: Any]) {
        DispatchQueue.main.async {
            do { call.resolve(try action()) }
            catch { call.reject("Secure session access failed or its generation changed. Sign in again if the device key is unavailable.") }
        }
    }
    @objc func read(_ call: CAPPluginCall) { run(call) { try AvidSessionStore.read() } }
    @objc func write(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let expected = call.getString("expectedGeneration"), let session = call.getObject("session") else { throw AvidSurfaceError.invalidInput }
                call.resolve(try await AvidAuthCoordinator.shared.writeSession(expected: expected, session: session, readOnly: call.getBool("readOnly") ?? true))
            } catch { call.reject("The secure session changed or could not be stored.") }
        }
    }
    @objc func clear(_ call: CAPPluginCall) {
        Task { @MainActor in
            do { call.resolve(try await AvidAuthCoordinator.shared.clearSession(expected: call.getString("expectedGeneration"))) }
            catch { call.reject("The secure session could not be cleared.") }
        }
    }
}

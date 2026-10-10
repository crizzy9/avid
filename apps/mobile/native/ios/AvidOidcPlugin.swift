import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import Security
import UIKit

/// One short-lived login attempt, including its callback inbox, in the main application's Keychain.
/// Reading routing metadata does not consume PKCE. Taking a transaction removes it before exchange.
@MainActor
enum AvidOidcStore {
    static let redirect = "avid://oauth2-callback"
    static let callbackNotification = Notification.Name("app.avid.oidc.callback")
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "app.avid.native-oidc", kSecAttrAccount as String: "pending"]
    enum Failure: LocalizedError {
        case invalid, unavailable
        var errorDescription: String? {
            switch self {
            case .invalid: return "Provider sign-in expired, changed, or has invalid callback data. Start again."
            case .unavailable: return "Provider sign-in could not access secure device storage."
            }
        }
    }
    private static func read() throws -> [String: Any]? {
        var request = query; request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let bytes = result as? Data, bytes.count <= 65536,
              let record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure.unavailable }
        return record
    }
    private static func persist(_ record: [String: Any]) throws {
        let bytes = try JSONSerialization.data(withJSONObject: record)
        guard bytes.count <= 65536 else { throw Failure.invalid }
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: bytes] as CFDictionary)
        if status == errSecItemNotFound {
            var creation = query; creation[kSecValueData as String] = bytes
            creation[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(creation as CFDictionary, nil) == errSecSuccess else { throw Failure.unavailable }
        } else if status != errSecSuccess { throw Failure.unavailable }
    }
    private static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure.unavailable }
    }
    private static func active(_ record: [String: Any]) throws -> Bool {
        guard let transaction = record["transaction"] as? [String: Any],
              let created = transaction["createdAt"] as? Double, let expires = transaction["expiresAt"] as? Double,
              created.isFinite, expires.isFinite else { return false }
        let now = Date().timeIntervalSince1970 * 1000
        let generation = try AvidSessionStore.read()["generation"] as? String
        return created <= now && now < expires && expires > created && expires - created <= 300000 &&
            (record["generation"] as? String) == generation
    }
    static func save(transaction: [String: Any], routing: [String: Any]) throws {
        let now = Date().timeIntervalSince1970 * 1000
        let secret = "^[A-Za-z0-9_-]{43}$"
        guard transaction["version"] as? Int == 1, let state = transaction["state"] as? String, !state.isEmpty, state.count <= 512,
              let verifier = transaction["codeVerifier"] as? String, verifier.range(of: secret, options: .regularExpression) != nil,
              let nonce = transaction["nonce"] as? String, nonce.range(of: secret, options: .regularExpression) != nil,
              transaction["redirectUri"] as? String == redirect,
              ["web", "native"].contains(transaction["clientKind"] as? String ?? ""),
              let server = transaction["serverUrl"] as? String, let serverURL = URL(string: server),
              ["https", "http"].contains(serverURL.scheme ?? ""), serverURL.host != nil, serverURL.user == nil, serverURL.password == nil,
              let profileId = transaction["profileId"] as? String, !profileId.isEmpty,
              let provider = transaction["providerSlug"] as? String, !provider.isEmpty,
        let profile = routing["profile"] as? [String: Any], profile["id"] as? String == profileId,
              let profileURL = profile["url"] as? String, normalize(profileURL) == server,
              routing["provider"] as? String == provider, routing["readOnly"] is Bool,
              let routed = routing["createdAt"] as? Double, routed.isFinite, routed <= now, now - routed < 300000 else { throw Failure.invalid }
        if let old = try read(), let previous = old["transaction"] as? [String: Any], previous["state"] as? String == state { throw Failure.invalid }
        guard let generation = try AvidSessionStore.read()["generation"] as? String else { throw Failure.unavailable }
        let record: [String: Any] = ["transaction": transaction, "routing": routing, "generation": generation]
        guard try active(record) else { throw Failure.invalid }
        try persist(record)
    }
    private static func normalize(_ raw: String) -> String {
        var value = raw
        while value.hasSuffix("/") { value.removeLast() }
        return value.hasSuffix("/api/v1") ? String(value.dropLast(7)) : value
    }
    static func pending() throws -> [String: Any]? {
        guard let record = try read() else { return nil }
        guard try active(record), let transaction = record["transaction"] as? [String: Any],
              let state = transaction["state"], let expires = transaction["expiresAt"], let routing = record["routing"],
              let generation = record["generation"] else { try remove(); return nil }
        var value: [String: Any] = ["state": state, "expiresAt": expires, "routing": routing, "generation": generation]
        if let callback = record["callbackUrl"] { value["callbackUrl"] = callback }
        return value
    }
    static func take(state: String) throws -> [String: Any]? {
        guard let record = try read(), let transaction = record["transaction"] as? [String: Any], transaction["state"] as? String == state else { return nil }
        try remove() // Single use, including expired or account-invalidated attempts.
        return try active(record) ? transaction : nil
    }
    static func cancel(state: String?) throws {
        if let state, let record = try read(), let transaction = record["transaction"] as? [String: Any], transaction["state"] as? String != state { return }
        try remove()
    }
    private static func one(_ parts: URLComponents, _ name: String) -> String? {
        let matches = (parts.queryItems ?? []).filter { $0.name == name }
        guard matches.count == 1, let value = matches[0].value, !value.isEmpty else { return nil }
        return value
    }
    static func authorization(state: String, raw: String) throws -> URL {
        guard let record = try read(), try active(record), let transaction = record["transaction"] as? [String: Any],
              transaction["state"] as? String == state, record["callbackUrl"] == nil,
              raw.count <= 16384, let parts = URLComponents(string: raw), let url = parts.url,
              ["https", "http"].contains(parts.scheme ?? ""), parts.host != nil, parts.user == nil, parts.password == nil, parts.fragment == nil,
              one(parts, "state") == state, one(parts, "redirect_uri") == redirect,
              one(parts, "nonce") == transaction["nonce"] as? String,
              one(parts, "response_type") == "code", one(parts, "code_challenge_method") == "S256",
              let verifier = transaction["codeVerifier"] as? String else { throw Failure.invalid }
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        guard one(parts, "code_challenge") == challenge else { throw Failure.invalid }
        return url
    }
    @discardableResult static func accept(_ url: URL) -> Bool {
        do {
            let raw = url.absoluteString
            guard raw.count <= 16384, raw.components(separatedBy: "?").first == redirect,
                  let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.fragment == nil,
                  let state = one(parts, "state"), state.count <= 512,
                  let record = try read(), try active(record), let transaction = record["transaction"] as? [String: Any],
                  transaction["state"] as? String == state else { return false }
            let codes = parts.queryItems?.filter { $0.name == "code" } ?? []
            let errors = parts.queryItems?.filter { $0.name == "error" } ?? []
            guard codes.count + errors.count == 1, let value = (codes + errors).first?.value, !value.isEmpty, value.count <= 8192 else { return false }
            if record["callbackUrl"] == nil {
                var next = record; next["callbackUrl"] = raw; try persist(next)
                NotificationCenter.default.post(name: callbackNotification, object: nil)
            }
            return true
        } catch { return false }
    }
    static func deny(state: String) {
        var parts = URLComponents(string: redirect)!
        parts.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "error", value: "access_denied")]
        if let url = parts.url { accept(url) }
    }
}

@objc(AvidOidcPlugin)
public class AvidOidcPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {
    public let identifier = "AvidOidcPlugin"
    public let jsName = "AvidOidc"
    public let pluginMethods: [CAPPluginMethod] = ["capabilities", "save", "take", "pending", "open", "cancel"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private var authentication: ASWebAuthenticationSession?
    private var activeState: String?
    private var callbackObserver: NSObjectProtocol?
    public override func load() {
        callbackObserver = NotificationCenter.default.addObserver(forName: AvidOidcStore.callbackNotification,
            object: nil, queue: .main) { [weak self] _ in self?.notifyListeners("callbackAvailable", data: [:]) }
    }
    deinit { if let callbackObserver { NotificationCenter.default.removeObserver(callbackObserver) } }
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
    private func run(_ call: CAPPluginCall, _ action: @escaping @MainActor () throws -> [String: Any]) {
        DispatchQueue.main.async {
            do { call.resolve(try action()) }
            catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func capabilities(_ call: CAPPluginCall) { run(call) { ["redirectUri": AvidOidcStore.redirect, "secureTransactions": true] } }
    @objc func save(_ call: CAPPluginCall) {
        run(call) {
            guard let transaction = call.getObject("transaction"), let routing = call.getObject("routing") else { throw AvidOidcStore.Failure.invalid }
            try AvidOidcStore.save(transaction: transaction, routing: routing)
            self.authentication?.cancel(); self.authentication = nil; self.activeState = nil
            return [:]
        }
    }
    @objc func take(_ call: CAPPluginCall) {
        run(call) {
            guard let state = call.getString("state") else { throw AvidOidcStore.Failure.invalid }
            return try AvidOidcStore.take(state: state).map { ["transaction": $0] } ?? [:]
        }
    }
    @objc func pending(_ call: CAPPluginCall) { run(call) { try AvidOidcStore.pending().map { ["pending": $0] } ?? [:] } }
    @objc func cancel(_ call: CAPPluginCall) {
        run(call) {
            let state = call.getString("state")
            try AvidOidcStore.cancel(state: state)
            if state == nil || state == self.activeState { self.authentication?.cancel(); self.authentication = nil; self.activeState = nil }
            return [:]
        }
    }
    @objc func open(_ call: CAPPluginCall) {
        run(call) {
            guard let state = call.getString("state"), let raw = call.getString("url"), self.bridge?.viewController?.view.window != nil else { throw AvidOidcStore.Failure.invalid }
            let url = try AvidOidcStore.authorization(state: state, raw: raw)
            self.authentication?.cancel()
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "avid") { [weak self] callback, _ in
                DispatchQueue.main.async {
                    if let callback { AvidOidcStore.accept(callback) } else { AvidOidcStore.deny(state: state) }
                    if self?.activeState == state { self?.authentication = nil; self?.activeState = nil }
                }
            }
            session.presentationContextProvider = self
            self.authentication = session; self.activeState = state
            guard session.start() else {
                self.authentication = nil; self.activeState = nil
                throw AvidOidcStore.Failure.unavailable
            }
            return [:]
        }
    }
}

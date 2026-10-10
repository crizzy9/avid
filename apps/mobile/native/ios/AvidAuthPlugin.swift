import Capacitor
import Foundation
import WebKit

/// Authentication endpoints never redirect credentials or mutate the shared jar during network I/O.
private final class AvidAuthRedirectPolicy: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class AvidAuthCoordinator {
    static let shared = AvidAuthCoordinator()
    static let changed = Notification.Name("app.avid.auth.session-changed")
    private var flight: (scope: String, generation: String, id: UUID, task: Task<[String: Any], Error>)?
    private var committing = false
    private var commitWaiters: [CheckedContinuation<Void, Never>] = []
    private var lastRefresh: (generation: String, date: Date)?
    enum Failure: LocalizedError {
        case changed, unauthorized, invalid, response
        var errorDescription: String? {
            switch self {
            case .changed: return "The account changed while authentication was in progress."
            case .unauthorized: return "Your saved connection has expired. Open Avid and sign in again."
            case .invalid: return "The native authentication request is invalid."
            case .response: return "The server could not renew this connection. Check your network or sign in again."
            }
        }
    }
    struct BoundSession {
        let record: [String: Any], session: [String: Any], server: String, user: String, generation: String
    }
    static func normalize(_ raw: String) throws -> String {
        guard var parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(parts.scheme?.lowercased() ?? ""), parts.host != nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else { throw Failure.invalid }
        parts.scheme = parts.scheme?.lowercased(); parts.host = parts.host?.lowercased()
        guard var value = parts.url?.absoluteString else { throw Failure.invalid }
        while value.hasSuffix("/") { value.removeLast() }
        if value.hasSuffix("/api/v1") { value = String(value.dropLast(7)) }
        return value
    }
    static func scope(_ session: [String: Any]) throws -> String {
        guard let profile = session["profile"] as? [String: Any], let raw = profile["url"] as? String,
              let user = session["userId"] as? String else { throw Failure.invalid }
        let identity = [try normalize(raw), user]
        return String(data: try JSONSerialization.data(withJSONObject: identity, options: [.withoutEscapingSlashes]), encoding: .utf8)!
    }
    func bound(_ accountScope: String) throws -> BoundSession {
        let record = try AvidSessionStore.read()
        guard let session = record["session"] as? [String: Any], let profile = session["profile"] as? [String: Any],
              let raw = profile["url"] as? String, let user = session["userId"] as? String,
              let generation = record["generation"] as? String,
              let input = try? JSONSerialization.jsonObject(with: Data(accountScope.utf8)) as? [String],
              input == [try Self.normalize(raw), user] else { throw Failure.unauthorized }
        return BoundSession(record: record, session: session, server: try Self.normalize(raw), user: user, generation: generation)
    }
    /// Unverified JWT metadata is used only to schedule renewal, never to establish identity.
    private func fresh(_ session: [String: Any]) -> Bool {
        guard let token = session["accessToken"] as? String else { return false }
        let pieces = token.split(separator: ".")
        guard pieces.count == 3 else { return false }
        var encoded = String(pieces[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let bytes = Data(base64Encoded: encoded), let json = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let expires = json["exp"] as? Double, expires.isFinite else { return false }
        return expires > Date().timeIntervalSince1970 + 60
    }
    func needsRefresh(scope: String) throws -> Bool { !fresh(try bound(scope).session) }
    /// Only server API sources use the saved BookOrbit connection. Public/file media remain independent.
    static func protects(scope: String, url: URL) -> Bool {
        guard let identity = try? JSONSerialization.jsonObject(with: Data(scope.utf8)) as? [String], identity.count == 2,
              let server = try? normalize(identity[0]), ["https", "http"].contains(url.scheme ?? "") else { return false }
        return url.absoluteString.hasPrefix(server + "/api/")
    }
    func waitForCookieCommit() async {
        while committing { await withCheckedContinuation { commitWaiters.append($0) } }
    }
    func writeSession(expected: String, session: [String: Any], readOnly: Bool) async throws -> [String: Any] {
        await waitForCookieCommit()
        if let prior = try AvidSessionStore.read()["session"] as? [String: Any] {
            guard try Self.scope(prior) == Self.scope(session) else { throw Failure.changed }
        }
        return try AvidSessionStore.write(expected: expected, session: session, readOnly: readOnly)
    }
    func clearSession(expected: String?) async throws -> [String: Any] {
        await waitForCookieCommit()
        if let expected { try assertGeneration(expected) }
        committing = true; defer { finishCommit() }
        AvidPlaybackOwner.shared.pause()
        let oldScope = AvidSharedStore.shared.activeScopeHash
        let next = try AvidSessionStore.clear(expected: expected)
        AvidPlaybackOwner.shared.clear()
        if let oldScope {
            AvidPlaybackSourceStore.removeAccount(scopeHash: oldScope)
            AvidMediaStore.shared.removeAccount(scopeHash: oldScope)
            AvidArtwork.removeAccount(scopeHash: oldScope)
        }
        AvidSharedStore.shared.clearActiveAccount()
        AvidSystemSurfaces.refresh()
        if let oldScope { AvidSystemSurfaces.removeAccount(oldScope) { _ in } }
        // The next login waits for this complete barrier. Late isolated responses cannot reapply cookies.
        for cookie in HTTPCookieStorage.shared.cookies ?? [] { HTTPCookieStorage.shared.deleteCookie(cookie) }
        let web = WKWebsiteDataStore.default().httpCookieStore
        for cookie in await web.allCookies() { await web.delete(cookie) }
        _ = await web.allCookies() // Barrier after WebKit's deletion notifications.
        for cookie in HTTPCookieStorage.shared.cookies ?? [] { HTTPCookieStorage.shared.deleteCookie(cookie) }
        return next
    }
    private func finishCommit() {
        committing = false
        let waiters = commitWaiters; commitWaiters = []
        waiters.forEach { $0.resume() }
    }
    private func assertGeneration(_ expected: String) throws {
        guard try AvidSessionStore.read()["generation"] as? String == expected else { throw Failure.changed }
    }
    private struct Reply { let status: Int, body: Any, cookies: [HTTPCookie] }
    private func request(url: URL, method: String = "POST", body: Data? = nil, token: String? = nil, cookies: [HTTPCookie] = []) async throws -> Reply {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.httpCookieAcceptPolicy = .never
        config.urlCache = nil; config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 20; config.timeoutIntervalForResource = 30
        let network = URLSession(configuration: config, delegate: AvidAuthRedirectPolicy(), delegateQueue: nil)
        defer { network.invalidateAndCancel() }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpBody = body
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if !cookies.isEmpty { request.setValue(HTTPCookie.requestHeaderFields(with: cookies)["Cookie"], forHTTPHeaderField: "Cookie") }
        let (bytes, response) = try await network.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == url, bytes.count <= 262144 else { throw Failure.response }
        let json: Any = bytes.isEmpty ? NSNull() : (try? JSONSerialization.jsonObject(with: bytes)) ?? ["message": "The authentication server returned an invalid response."]
        var headers: [String: String] = [:]
        http.allHeaderFields.forEach { key, value in headers[String(describing: key)] = String(describing: value) }
        let accepted = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).filter {
            ["access_token", "refresh_token"].contains($0.name) &&
                $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == url.host?.lowercased()
        }
        return Reply(status: http.statusCode, body: json, cookies: accepted)
    }
    private func apply(_ cookies: [HTTPCookie]) async {
        for cookie in cookies { HTTPCookieStorage.shared.setCookie(cookie) }
        let web = WKWebsiteDataStore.default().httpCookieStore
        for cookie in cookies { await web.setCookie(cookie) }
    }
    private func requestCookies(for url: URL) async -> [HTTPCookie] {
        // Cold car/App Intent launches may precede Capacitor's WK -> Foundation synchronization.
        // Read into an isolated request, never synchronize old cookies globally during a network phase.
        var values = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
        for cookie in HTTPCookieStorage.shared.cookies(for: url) ?? [] {
            values.removeAll { $0.name == cookie.name && $0.domain == cookie.domain && $0.path == cookie.path }
            values.append(cookie)
        }
        return values.filter {
            $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: ".")).lowercased() == url.host?.lowercased() &&
                (!$0.isSecure || url.scheme == "https") && ($0.expiresDate == nil || $0.expiresDate! > Date()) &&
                (url.path == $0.path || url.path.hasPrefix($0.path.hasSuffix("/") ? $0.path : $0.path + "/"))
        }
    }
    func authenticate(expected: String, server raw: String, path: String, body text: String) async throws -> [String: Any] {
        guard ["login", "oidc/callback"].contains(path), text.utf8.count <= 65536,
              let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              object["clientKind"] as? String != "native" else { throw Failure.invalid }
        let server = try Self.normalize(raw)
        guard let url = URL(string: server + "/api/v1/auth/" + path) else { throw Failure.invalid }
        try assertGeneration(expected)
        guard try AvidSessionStore.read()["session"] == nil else { throw Failure.changed }
        let reply = try await request(url: url, body: Data(text.utf8))
        await waitForCookieCommit()
        try assertGeneration(expected)
        guard try AvidSessionStore.read()["session"] == nil else { throw Failure.changed }
        if (200..<300).contains(reply.status) {
            guard let auth = reply.body as? [String: Any], let token = auth["accessToken"] as? String, !token.isEmpty,
                  let user = auth["user"] as? [String: Any], user["id"] != nil,
                  user["username"] is String, reply.cookies.contains(where: { $0.name == "access_token" }) else { throw Failure.response }
            committing = true; defer { finishCommit() }
            await apply(reply.cookies)
        }
        return ["status": reply.status, "body": reply.body]
    }
    func refresh(scope: String, expected: String? = nil, force: Bool = false) async throws -> [String: Any] {
        // A newly persisted token is not usable until the corresponding cookie commit completes.
        await waitForCookieCommit()
        let binding = try bound(scope)
        if let expected, expected != binding.generation { throw Failure.changed }
        if let flight, flight.scope == scope && flight.generation == binding.generation { return try await flight.task.value }
        if !force && fresh(binding.session) { return binding.record }
        if force, let lastRefresh, lastRefresh.generation == binding.generation, Date().timeIntervalSince(lastRefresh.date) < 5 { return binding.record }
        let id = UUID()
        let task = Task { @MainActor in try await self.performRefresh(binding, scope: scope) }
        flight = (scope, binding.generation, id, task)
        defer { if flight?.id == id { flight = nil } }
        return try await task.value
    }
    private func performRefresh(_ bound: BoundSession, scope: String) async throws -> [String: Any] {
        guard let refreshURL = URL(string: bound.server + "/api/v1/auth/refresh"),
              let meURL = URL(string: bound.server + "/api/v1/auth/me") else { throw Failure.invalid }
        var payload: [String: Any] = [:]
        if let token = bound.session["refreshToken"] as? String { payload["refreshToken"] = token }
        let priorCookies = await requestCookies(for: refreshURL)
        try assertGeneration(bound.generation)
        let response = try await request(url: refreshURL, body: JSONSerialization.data(withJSONObject: payload), cookies: priorCookies)
        try assertGeneration(bound.generation)
        guard (200..<300).contains(response.status), let result = response.body as? [String: Any],
              let token = result["accessToken"] as? String, !token.isEmpty else { throw Failure.unauthorized }
        let identity = try await request(url: meURL, method: "GET", token: token)
        guard (200..<300).contains(identity.status), let user = identity.body as? [String: Any],
              String(describing: user["id"] ?? "") == bound.user, user["active"] as? Bool == true else { throw Failure.unauthorized }
        await waitForCookieCommit()
        try assertGeneration(bound.generation)
        var session = bound.session; session["accessToken"] = token
        if let refresh = result["refreshToken"] as? String { session["refreshToken"] = refresh }
        if session["clientKind"] as? String != "native" && !response.cookies.contains(where: { $0.name == "access_token" }) { throw Failure.response }
        // All native vault mutations wait for this short cookie commit. Network I/O above never holds it.
        committing = true; defer { finishCommit() }
        let next = try AvidSessionStore.write(expected: bound.generation, session: session, readOnly: bound.record["readOnly"] as? Bool ?? true)
        await apply(response.cookies)
        if let generation = next["generation"] as? String {
            lastRefresh = (generation, Date())
            NotificationCenter.default.post(name: Self.changed, object: nil, userInfo: ["generation": generation, "accountScope": scope])
        }
        return next
    }
}

@objc(AvidAuthPlugin)
public class AvidAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidAuthPlugin"
    public let jsName = "AvidAuth"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "refresh", returnType: CAPPluginReturnPromise)]
    private var observer: NSObjectProtocol?
    public override func load() {
        observer = NotificationCenter.default.addObserver(forName: AvidAuthCoordinator.changed, object: nil, queue: .main) { [weak self] notification in
            guard let value = notification.userInfo as? [String: String] else { return }
            self?.notifyListeners("sessionChanged", data: value)
        }
    }
    deinit { if let observer { NotificationCenter.default.removeObserver(observer) } }
    @objc func authenticate(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let generation = call.getString("expectedGeneration"), let server = call.getString("serverUrl"),
                      let path = call.getString("path"), let body = call.getString("body") else { throw AvidAuthCoordinator.Failure.invalid }
                call.resolve(try await AvidAuthCoordinator.shared.authenticate(expected: generation, server: server, path: path, body: body))
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func refresh(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let scope = call.getString("accountScope") else { throw AvidAuthCoordinator.Failure.invalid }
                call.resolve(try await AvidAuthCoordinator.shared.refresh(scope: scope, expected: call.getString("expectedGeneration"), force: call.getBool("force") ?? false))
            } catch { call.reject(error.localizedDescription) }
        }
    }
}

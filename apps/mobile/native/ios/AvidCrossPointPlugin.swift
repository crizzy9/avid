import Foundation
import Capacitor
import Darwin

private enum CrossPointFailure: Error { case invalid, cancelled, unavailable }

/** A separate ephemeral URLSession for each bounded, credential-free reader request. */
private final class CrossPointTransfer: NSObject, URLSessionDataDelegate {
    let created = Date()
    private let lock = NSRecursiveLock()
    private var call: CAPPluginCall?
    private var session: URLSession?
    private var discoverySocket: Int32 = -1
    private var task: URLSessionDataTask?
    private var bytes = Data()
    private var offset = 0
    private var response: HTTPURLResponse?
    private var limit = 0
    private var closed = false
    private var finished = false
    let id: String
    init(id: String, call: CAPPluginCall) { self.id = id; self.call = call }
    func start(_ request: URLRequest, limit: Int) throws {
        lock.lock(); defer { lock.unlock() }
        guard !closed else { throw CrossPointFailure.cancelled }
        self.limit = limit
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.connectionProxyDictionary = ["HTTPEnable": 0, "HTTPSEnable": 0, "SOCKSEnable": 0, "ProxyAutoConfigEnable": 0, "ProxyAutoDiscoveryEnable": 0]
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 35
        let queue = OperationQueue(); queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        self.session = session
        let task = session.dataTask(with: request); self.task = task; task.resume()
    }
    func fail() {
        lock.lock(); defer { lock.unlock() }
        closed = true; bytes.removeAll(); task?.cancel(); task = nil
        if discoverySocket >= 0 { Darwin.close(discoverySocket); discoverySocket = -1 }
        session?.invalidateAndCancel(); session = nil
        call?.reject("The reader request failed, was canceled, or is unavailable. Check local-network access. Verify an attempted upload before sending again.")
        call = nil
    }
    /// iOS permits ordinary unicast without the restricted multicast entitlement.
    /// Probe the firmware's default mDNS name and its documented access-point address.
    func discover() {
        lock.lock()
        guard !closed else { lock.unlock(); return }
        discoverySocket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
        guard discoverySocket >= 0 else { lock.unlock(); fail(); return }
        var timeout = timeval(tv_sec: 0, tv_usec: 100_000)
        guard setsockopt(discoverySocket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size)) == 0 else { lock.unlock(); fail(); return }
        lock.unlock()
        sendHello("192.168.4.1")
        DispatchQueue.global(qos: .utility).async { [weak self] in
            if let ip = try? AvidCrossPointPlugin.resolve("crosspoint.local"), !ip.contains(":") { self?.sendHello(ip) }
        }
        let started = ProcessInfo.processInfo.systemUptime; var found: [String: String] = [:]
        while ProcessInfo.processInfo.systemUptime - started < 4 && found.count < 32 {
            lock.lock()
            guard !closed else { lock.unlock(); return }
            var buffer = [UInt8](repeating: 0, count: 257)
            var peer = sockaddr_in(); var length = socklen_t(MemoryLayout<sockaddr_in>.size)
            let size = withUnsafeMutablePointer(to: &peer) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(discoverySocket, &buffer, buffer.count, 0, $0, &length) } }
            let socketError = errno
            lock.unlock()
            if size < 0 && ![EAGAIN, EWOULDBLOCK, EINTR].contains(socketError) { fail(); return }
            if size > 0 && size <= 256 && UInt16(bigEndian: peer.sin_port) == 8134 {
                var ipBuffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                guard inet_ntop(AF_INET, &peer.sin_addr, &ipBuffer, socklen_t(ipBuffer.count)) != nil else { continue }
                let ip = String(cString: ipBuffer)
                guard AvidCrossPointPlugin.local(ip), let value = String(bytes: buffer.prefix(size), encoding: .ascii),
                      let match = value.range(of: "^crosspoint \\(on [A-Za-z0-9_.-]{1,128}\\);[0-9]{1,5}$", options: .regularExpression), match == value.startIndex..<value.endIndex,
                      let separator = value.range(of: ");"), let port = Int(value[separator.upperBound...]), (1...65535).contains(port) else { continue }
                found["http://\(ip)"] = String(value[value.index(value.startIndex, offsetBy: 15)..<separator.lowerBound])
            }
        }
        lock.lock(); defer { lock.unlock() }
        guard !closed else { return }
        // Advertised port is WebSocket-only; HTTP stays on 80. A status inspection still follows.
        call?.resolve(["readers": found.keys.sorted().map { ["address": $0, "hostname": found[$0]!] }]); call = nil
        closed = true
        if discoverySocket >= 0 { Darwin.close(discoverySocket); discoverySocket = -1 }
    }
    private func sendHello(_ ip: String) {
        lock.lock(); defer { lock.unlock() }
        guard !closed, discoverySocket >= 0, AvidCrossPointPlugin.local(ip) else { return }
        var target = sockaddr_in(); target.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); target.sin_family = sa_family_t(AF_INET); target.sin_port = UInt16(8134).bigEndian
        guard inet_pton(AF_INET, ip, &target.sin_addr) == 1 else { return }
        let bytes: [UInt8] = Array("hello".utf8)
        _ = withUnsafePointer(to: &target) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(discoverySocket, bytes, bytes.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    }
    func read() throws -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        guard !closed, finished else { throw CrossPointFailure.unavailable }
        let end = min(offset + 256 * 1024, bytes.count)
        let chunk = Array(bytes[offset..<end]); offset = end
        let done = offset == bytes.count
        if done { bytes.removeAll(); closed = true }
        return ["bytes": chunk.map(Int.init), "done": done]
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil); fail()
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); defer { lock.unlock() }
        guard !closed, let http = response as? HTTPURLResponse, !(300..<400).contains(http.statusCode), response.expectedContentLength <= limit else { completionHandler(.cancel); fail(); return }
        self.response = http; completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard !closed, data.count <= limit - bytes.count else { fail(); return }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); defer { lock.unlock() }
        guard !closed, error == nil, let response else { fail(); return }
        finished = true
        let headers = ["Content-Type", "Content-Length"].compactMap { key -> [String]? in response.value(forHTTPHeaderField: key).map { [key, $0] } }
        call?.resolve(["id": id, "status": response.statusCode, "statusText": HTTPURLResponse.localizedString(forStatusCode: response.statusCode), "headers": headers])
        call = nil; self.task = nil; session.finishTasksAndInvalidate(); self.session = nil
    }
}

@objc(AvidCrossPointPlugin)
public class AvidCrossPointPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidCrossPointPlugin"
    public let jsName = "AvidCrossPoint"
    public let pluginMethods: [CAPPluginMethod] = ["open", "read", "close", "discover"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private let lock = NSRecursiveLock()
    private var transfers: [String: CrossPointTransfer] = [:]
    private var cancelled: [String: Date] = [:]
    private static let uploadLimit = 64 * 1024 * 1024 + 64 * 1024
    private func begin(_ id: String, call: CAPPluginCall) throws -> CrossPointTransfer {
        lock.lock(); defer { lock.unlock() }
        guard UUID(uuidString: id) != nil else { throw CrossPointFailure.invalid }
        let now = Date()
        cancelled = cancelled.filter { now.timeIntervalSince($0.value) < 120 }
        for (key, value) in transfers where now.timeIntervalSince(value.created) >= 120 { value.fail(); transfers.removeValue(forKey: key) }
        guard cancelled[id] == nil, cancelled.count < 256, transfers[id] == nil, transfers.count < 2 else { throw CrossPointFailure.cancelled }
        let transfer = CrossPointTransfer(id: id, call: call); transfers[id] = transfer; return transfer
    }
    private func close(_ id: String) {
        lock.lock(); defer { lock.unlock() }
        cancelled = cancelled.filter { Date().timeIntervalSince($0.value) < 120 }
        if cancelled.count < 256 { cancelled[id] = Date() }
        transfers.removeValue(forKey: id)?.fail()
    }
    @objc func open(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Invalid reader request."); return }
        do {
            let transfer = try begin(id, call: call)
            DispatchQueue.global(qos: .userInitiated).async {
                do { let (request, limit) = try Self.request(call); try transfer.start(request, limit: limit) }
                catch { self.close(id) }
            }
        } catch { call.reject("Reader request canceled or too many active requests.") }
    }
    @objc func discover(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Invalid reader discovery request."); return }
        do {
            let transfer = try begin(id, call: call)
            DispatchQueue.global(qos: .userInitiated).async { transfer.discover() }
        } catch { call.reject("Reader discovery was canceled or too many requests are active.") }
    }
    @objc func read(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Invalid reader request."); return }
        lock.lock(); let transfer = transfers[id]; lock.unlock()
        do {
            guard let transfer else { throw CrossPointFailure.invalid }
            let chunk = try transfer.read(); call.resolve(chunk)
            if chunk["done"] as? Bool == true { close(id) }
        } catch { close(id); call.reject("The reader response is closed.") }
    }
    @objc func close(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil else { call.reject("Invalid reader request."); return }
        close(id); call.resolve()
    }
    deinit { transfers.values.forEach { $0.fail() } }
    private static func path(_ value: String) -> Bool {
        value.hasPrefix("/") && value.utf8.count <= 4096 && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 || "\\%<>:\"|?*".unicodeScalars.contains($0) } && value.split(separator: "/").allSatisfy { !$0.hasPrefix(".") && !$0.hasSuffix(".") && !$0.hasSuffix(" ") && !["system volume information", "xtcache"].contains($0.lowercased()) }
    }
    fileprivate static func local(_ address: String) -> Bool {
        var v4 = in_addr()
        if inet_pton(AF_INET, address, &v4) == 1 {
            let value = UInt32(bigEndian: v4.s_addr)
            return value >> 24 == 10 || value >> 24 == 127 || value >> 20 == 0xac1 || value >> 16 == 0xc0a8 || value >> 16 == 0xa9fe
        }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, address, &v6) == 1 {
            let bytes = withUnsafeBytes(of: &v6) { Array($0) }
            if bytes.prefix(15).allSatisfy({ $0 == 0 }) && bytes[15] == 1 { return true }
            if bytes[0] & 0xfe == 0xfc || (bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80) { return true }
            if bytes.prefix(10).allSatisfy({ $0 == 0 }) && bytes[10] == 255 && bytes[11] == 255 { return local(bytes[12...15].map(String.init).joined(separator: ".")) }
        }
        return false
    }
    fileprivate static func resolve(_ hostname: String) throws -> String {
        var hints = addrinfo(); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM; hints.ai_protocol = IPPROTO_TCP
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(hostname, nil, &hints, &result) == 0, let first = result else { throw CrossPointFailure.unavailable }
        defer { freeaddrinfo(first) }
        var current: UnsafeMutablePointer<addrinfo>? = first; var addresses: [String] = []
        while let value = current {
            guard addresses.count < 32 else { throw CrossPointFailure.invalid }
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(value.pointee.ai_addr, value.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else { throw CrossPointFailure.invalid }
            let address = String(cString: buffer)
            guard local(address) else { throw CrossPointFailure.invalid }
            addresses.append(address); current = value.pointee.ai_next
        }
        guard let selected = addresses.first(where: { !$0.contains(":") }) ?? addresses.first else { throw CrossPointFailure.invalid }
        return selected
    }
    private static func request(_ call: CAPPluginCall) throws -> (URLRequest, Int) {
        guard let raw = call.getString("url"), raw.utf8.count <= 16384, let parts = URLComponents(string: raw), let scheme = parts.scheme, ["http", "https"].contains(scheme), let host = parts.host, parts.user == nil, parts.password == nil, parts.fragment == nil, let query = parts.queryItems, query.count == 1, let value = query[0].value, let method = call.getString("method") else { throw CrossPointFailure.invalid }
        let limit: Int
        switch (method, parts.percentEncodedPath, query[0].name) {
        case ("GET", "/api/status", "plugin") where value == "avid": limit = 64 * 1024
        case ("GET", "/api/files", "path") where path(value): limit = 2 * 1024 * 1024
        case ("GET", "/download", "path") where path(value) && value.lowercased().hasSuffix(".epub"): limit = 64 * 1024 * 1024
        case ("POST", "/upload", "path") where path(value): limit = 64 * 1024
        default: throw CrossPointFailure.invalid
        }
        let hostname = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        let ip = try resolve(hostname)
        // Pin HTTP DNS to the checked address. HTTPS uses a numeric address and normal system TLS validation.
        // Hostname-based HTTPS cannot be safely pinned by URLSession, so use the IP displayed by the reader.
        guard scheme == "http" || local(hostname) else { throw CrossPointFailure.invalid }
        let authority = ip.contains(":") ? "[\(ip)]" : ip
        let port = parts.port.map { ":\($0)" } ?? ""
        guard let url = URL(string: "\(scheme)://\(authority)\(port)\(parts.percentEncodedPath)?\(parts.percentEncodedQuery ?? "")") else { throw CrossPointFailure.invalid }
        var request = URLRequest(url: url); request.httpMethod = method; request.httpShouldHandleCookies = false
        request.setValue("\(host)\(port)", forHTTPHeaderField: "Host")
        let headers = call.getArray("headers", [String].self) ?? []
        guard headers.count <= 16 else { throw CrossPointFailure.invalid }
        if method == "POST" {
            let content = headers.filter { $0.count == 2 && $0[0].lowercased() == "content-type" }
            guard content.count == 1, content[0][1].hasPrefix("multipart/form-data; boundary="), content[0][1].utf8.count <= 256, !content[0][1].contains("\r"), !content[0][1].contains("\n"), let encoded = call.getString("bodyBase64"), encoded.utf8.count <= 4 * ((uploadLimit + 2) / 3), let bytes = Data(base64Encoded: encoded), !bytes.isEmpty, bytes.count <= uploadLimit else { throw CrossPointFailure.invalid }
            request.setValue(content[0][1], forHTTPHeaderField: "Content-Type"); request.httpBody = bytes
        } else if call.getString("bodyBase64") != nil { throw CrossPointFailure.invalid }
        return (request, limit)
    }
}

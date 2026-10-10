import Capacitor
import CryptoKit
import Foundation

/// Native imports are explicit, account-bound receipts. A WebView cannot authorize arbitrary paths.
@MainActor
final class AvidMediaStore {
    static let shared = AvidMediaStore()
    private let fileLimit: Int64 = 4 * 1024 * 1024 * 1024
    private let totalLimit: Int64 = 8 * 1024 * 1024 * 1024
    private let chunkLimit = 256 * 1024
    private struct Receipt: Codable {
        let id: String, accountScope: String, bookId: String, fileId: String, trackId: String, mime: String
        let size: Int64, sha256: String
        let createdAt: Date
    }
    private final class Transfer {
        let id: String, scope: String, generation: String, book: String, file: String, track: String, mime: String
        let size: Int64, path: URL, handle: FileHandle
        var offset: Int64 = 0
        var hash = SHA256()
        var updatedAt = Date()
        init(id: String, scope: String, generation: String, book: String, file: String, track: String, mime: String, size: Int64, path: URL, handle: FileHandle) {
            self.id = id; self.scope = scope; self.generation = generation; self.book = book; self.file = file; self.track = track; self.mime = mime; self.size = size; self.path = path; self.handle = handle
        }
    }
    private var transfers: [String: Transfer] = [:]
    enum Failure: LocalizedError {
        case invalid, changed, limit, missing
        var errorDescription: String? {
            switch self {
            case .invalid: return "The local audio transfer is invalid or out of order."
            case .changed: return "The account changed during the local audio transfer."
            case .limit: return "Local audio imports allow four transfers, 4 GB per file and 8 GB total."
            case .missing: return "This native audio file is unavailable. Import it again."
            }
        }
    }
    private func root() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var value = base.appendingPathComponent("AvidMedia", isDirectory: true)
        try FileManager.default.createDirectory(at: value, withIntermediateDirectories: true)
        var properties = URLResourceValues(); properties.isExcludedFromBackup = true
        try value.setResourceValues(properties)
        return value
    }
    private func directory(_ scope: String) throws -> URL {
        let value = try root().appendingPathComponent(AvidSharedStore.scopeHash(scope), isDirectory: true)
        try FileManager.default.createDirectory(at: value, withIntermediateDirectories: true)
        return value
    }
    private func generation(_ scope: String) throws -> String {
        let record = try AvidSessionStore.read()
        guard let generation = record["generation"] as? String,
              let identity = try? JSONSerialization.jsonObject(with: Data(scope.utf8)) as? [String], identity.count == 2 else { throw Failure.invalid }
        if let session = record["session"] as? [String: Any] {
            guard let profile = session["profile"] as? [String: Any], let url = profile["url"] as? String,
                  let user = session["userId"] as? String, identity == [try AvidAuthCoordinator.normalize(url), user] else { throw Failure.changed }
        } else {
            guard identity == ["https://demo.avid.invalid", "demo"] else { throw Failure.changed }
        }
        return generation
    }
    private func active(_ id: String) throws -> Transfer {
        guard let value = transfers[id], try generation(value.scope) == value.generation else { throw Failure.changed }
        return value
    }
    private func occupied() throws -> Int64 {
        let base = try root()
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        guard let entries = FileManager.default.enumerator(at: base, includingPropertiesForKeys: keys) else { return 0 }
        var total: Int64 = 0
        let live = Set(transfers.values.map { $0.path })
        for case let url as URL in entries {
            let values = try url.resourceValues(forKeys: Set(keys))
            guard values.isRegularFile == true else { continue }
            if url.pathExtension == "part", !live.contains(url), Date().timeIntervalSince(values.contentModificationDate ?? .distantPast) > 3600 {
                try FileManager.default.removeItem(at: url)
            } else { total += Int64(values.fileSize ?? 0) }
        }
        return total
    }
    func begin(scope: String, book: String, file: String, track: String, size: Double, mime: String) throws -> String {
        for value in Array(transfers.values) where Date().timeIntervalSince(value.updatedAt) > 3600 { cancel(id: value.id) }
        guard scope.utf8.count <= 8192, [book, file, track].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 4096 }),
              size.isFinite, size.rounded(.towardZero) == size, size > 0, size <= Double(fileLimit), mime.utf8.count <= 128 else { throw Failure.invalid }
        guard transfers.count < 4 else { throw Failure.limit }
        let captured = try generation(scope)
        let reserved = transfers.values.reduce(Int64(0)) { $0 + $1.size - $1.offset }
        guard try occupied() + reserved + Int64(size) <= totalLimit else { throw Failure.limit }
        let folder = try directory(scope)
        let id = UUID().uuidString.lowercased()
        let path = folder.appendingPathComponent(id).appendingPathExtension("part")
        guard FileManager.default.createFile(atPath: path.path, contents: nil, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { throw Failure.missing }
        let handle = try FileHandle(forWritingTo: path)
        transfers[id] = Transfer(id: id, scope: scope, generation: captured, book: book, file: file, track: track, mime: mime, size: Int64(size), path: path, handle: handle)
        return id
    }
    func append(id: String, offset: Double, base64: String) throws {
        let value = try active(id)
        guard offset.isFinite, offset == Double(value.offset), base64.utf8.count <= 4 * ((chunkLimit + 2) / 3),
              let bytes = Data(base64Encoded: base64), !bytes.isEmpty, bytes.count <= chunkLimit,
              value.offset + Int64(bytes.count) <= value.size else { throw Failure.invalid }
        try value.handle.write(contentsOf: bytes)
        value.hash.update(data: bytes); value.offset += Int64(bytes.count); value.updatedAt = Date()
    }
    func finish(id: String) throws -> URL {
        let value = try active(id)
        guard value.offset == value.size else { throw Failure.invalid }
        try value.handle.synchronize(); try value.handle.close()
        let digest = value.hash.finalize().map { String(format: "%02x", $0) }.joined()
        let folder = value.path.deletingLastPathComponent()
        // A new WebView object URL may identify the same imported bytes after reopening a book.
        // Reuse requires content hash AND every account/source identifier, never size alone.
        for metadata in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey]) where metadata.pathExtension == "json" {
            guard let size = (try? metadata.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size <= 262144,
                  let data = try? Data(contentsOf: metadata), let previous = try? JSONDecoder().decode(Receipt.self, from: data),
                  previous.sha256 == digest, previous.size == value.size,
                  previous.accountScope == value.scope, previous.bookId == value.book, previous.fileId == value.file, previous.trackId == value.track else { continue }
            let audio = metadata.deletingPathExtension().appendingPathExtension("audio")
            if owns(audio, scope: value.scope, book: value.book, file: value.file, track: value.track) {
                try FileManager.default.removeItem(at: value.path); transfers.removeValue(forKey: id); return audio
            }
        }
        let path = value.path.deletingPathExtension().appendingPathExtension("audio")
        try FileManager.default.moveItem(at: value.path, to: path)
        let receipt = Receipt(id: id, accountScope: value.scope, bookId: value.book, fileId: value.file, trackId: value.track, mime: value.mime,
                              size: value.size, sha256: digest, createdAt: Date())
        do {
            let receiptPath = path.deletingPathExtension().appendingPathExtension("json")
            try JSONEncoder().encode(receipt).write(to: receiptPath, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            transfers.removeValue(forKey: id)
            return path
        } catch {
            try? FileManager.default.removeItem(at: path); transfers.removeValue(forKey: id); throw error
        }
    }
    func cancel(id: String) {
        guard let value = transfers.removeValue(forKey: id) else { return }
        try? value.handle.close(); try? FileManager.default.removeItem(at: value.path)
    }
    func owns(_ url: URL, scope: String, book: String, file: String, track: String) -> Bool {
        do {
            _ = try generation(scope)
            guard url.isFileURL, url.query == nil, url.fragment == nil, url.pathExtension == "audio" else { return false }
            let folder = try directory(scope).standardizedFileURL
            guard url.deletingLastPathComponent().standardizedFileURL == folder else { return false }
            let id = url.deletingPathExtension().lastPathComponent
            guard UUID(uuidString: id) != nil else { return false }
            let receiptURL = folder.appendingPathComponent(id).appendingPathExtension("json")
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            let receiptSize = (try FileManager.default.attributesOfItem(atPath: receiptURL.path)[.size] as? NSNumber)?.intValue ?? 0
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  receiptSize > 0, receiptSize <= 262144 else { return false }
            let receipt = try JSONDecoder().decode(Receipt.self, from: Data(contentsOf: receiptURL))
            return receipt.id == id && receipt.accountScope == scope && receipt.bookId == book && receipt.fileId == file && receipt.trackId == track && receipt.size == Int64(values.fileSize ?? -1)
        } catch { return false }
    }
    func removeAccount(scopeHash: String) {
        guard scopeHash.count == 64, scopeHash.allSatisfy({ $0.isHexDigit }) else { return }
        for value in Array(transfers.values) where AvidSharedStore.scopeHash(value.scope) == scopeHash { cancel(id: value.id) }
        if let path = try? root().appendingPathComponent(scopeHash, isDirectory: true) { try? FileManager.default.removeItem(at: path) }
    }
}

@objc(AvidMediaStorePlugin)
public class AvidMediaStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidMediaStorePlugin"
    public let jsName = "AvidMediaStore"
    public let pluginMethods: [CAPPluginMethod] = ["begin", "append", "finish", "cancel", "validate"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    @objc func begin(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let scope = call.getString("accountScope"), let book = call.getString("bookId"), let file = call.getString("fileId"),
                      let track = call.getString("trackId"), let size = call.getDouble("size") else { throw AvidMediaStore.Failure.invalid }
                call.resolve(["id": try AvidMediaStore.shared.begin(scope: scope, book: book, file: file, track: track, size: size, mime: call.getString("mime") ?? "")])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func append(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let id = call.getString("id"), let offset = call.getDouble("offset"), let data = call.getString("dataBase64") else { throw AvidMediaStore.Failure.invalid }
                try AvidMediaStore.shared.append(id: id, offset: offset, base64: data); call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func finish(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let id = call.getString("id") else { throw AvidMediaStore.Failure.invalid }
                call.resolve(["url": try AvidMediaStore.shared.finish(id: id).absoluteString])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func cancel(_ call: CAPPluginCall) {
        Task { @MainActor in
            if let id = call.getString("id") { AvidMediaStore.shared.cancel(id: id) }
            call.resolve()
        }
    }
    @objc func validate(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard let scope = call.getString("accountScope"), let book = call.getString("bookId"), let file = call.getString("fileId"),
                  let track = call.getString("trackId"), let raw = call.getString("url"), let url = URL(string: raw) else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": AvidMediaStore.shared.owns(url, scope: scope, book: book, file: file, track: track)])
        }
    }
}

import Foundation
import CoreFoundation
import SQLite3
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

/// The connection epoch cancels unfinished binary transfers, never access to a local account partition.
/// Hold this lock while a bounded append/finish runs so logout cannot race its publication.
final class AvidLibraryStorageEpoch {
    static let shared = AvidLibraryStorageEpoch()
    private let lock = NSRecursiveLock()
    private var value: UInt64 = 0
    func invalidate() { lock.lock(); defer { lock.unlock() }; value &+= 1 }
    func withValue<T>(_ action: (UInt64) throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }; return try action(value)
    }
}

/// Private, account-scoped SQLite metadata and immutable files. No credentials or network requests.
/// Foundation + SQLite only: the actual backend is also exercised by the standalone native test binary.
final class AvidLibraryStorage {
    static let tables = Set(["books", "anchors", "annotations", "collections", "sessions", "preferences", "outbox", "localFiles", "nativeReceipts"])
    static let chunkBytes = 256 * 1024
    static let fileBytes: Int64 = 4 * 1024 * 1024 * 1024
    static let totalBytes: Int64 = 8 * 1024 * 1024 * 1024
    private static let rowBytes = 8 * 1024 * 1024
    private static let batchBytes = 64 * 1024 * 1024
    private static let maxRows = 100_000
    private static let ttl: Int64 = 60 * 60 * 1000
    private let lock = NSRecursiveLock()
    private let directory: URL
    private let processID: String
    private let now: () -> Int64
    private var database: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    enum Failure: LocalizedError {
        case invalid(String), storage
        var errorDescription: String? {
            switch self {
            case .invalid(let message): return message
            case .storage: return "The private library store could not complete this operation."
            }
        }
    }
    private enum Bind { case text(String), number(Int64), null }
    private struct BlobRecord {
        let id: String, scope: String, size: Int64, mime: String, name: String
        let state: Int64, offset: Int64, updatedAt: Int64, processID: String, epoch: Int64
        var reference: [String: Any] { ["blobId": id, "size": size, "mime": mime, "name": name] }
    }

    static func defaultDirectory() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AvidLibrary", isDirectory: true)
    }
    init(directory: URL, processID: String = UUID().uuidString, now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }) throws {
        self.directory = directory; self.processID = processID; self.now = now
        try privateDirectory(directory)
        try privateDirectory(directory.appendingPathComponent("blobs", isDirectory: true))
        let path = directory.appendingPathComponent("library.sqlite3")
        for suffix in ["", "-wal", "-shm"] { _ = try regularOptional(directory.appendingPathComponent("library.sqlite3" + suffix)) }
        if !FileManager.default.fileExists(atPath: path.path) { try createFile(path) }
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }; throw Failure.storage
        }
        database = handle
        do {
            guard sqlite3_busy_timeout(handle, 5000) == SQLITE_OK else { throw Failure.storage }
            try execute("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;")
            let version = try scalar("PRAGMA user_version")
            guard version <= 1 else { throw Failure.invalid("This library store requires a newer Avid version.") }
            if version == 0 {
                try transaction(write: true) {
                    try execute("""
                    CREATE TABLE IF NOT EXISTS revisions(scope TEXT NOT NULL, table_name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), PRIMARY KEY(scope,table_name));
                    CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), mime TEXT NOT NULL, name TEXT NOT NULL, state INTEGER NOT NULL CHECK(state IN(0,1)), offset INTEGER NOT NULL, created_at INTEGER NOT NULL, process_id TEXT NOT NULL, epoch INTEGER NOT NULL);
                    CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, table_name TEXT NOT NULL, id TEXT NOT NULL, row_key TEXT NOT NULL, json TEXT NOT NULL, entity_key TEXT, blob_id TEXT REFERENCES blobs(id), PRIMARY KEY(scope,table_name,id));
                    CREATE INDEX IF NOT EXISTS record_entity ON records(scope,table_name,entity_key);
                    CREATE INDEX IF NOT EXISTS record_blob ON records(blob_id);
                    CREATE INDEX IF NOT EXISTS blob_scope ON blobs(scope);
                    PRAGMA user_version=1;
                    """)
                }
            }
            try syncDirectory(directory)
        } catch { sqlite3_close(handle); database = nil; throw error }
    }
    deinit { if let database { sqlite3_close(database) } }

    func read(_ request: [String: Any]) throws -> [String: Any] {
        try locked {
            try keys(request, allowed: ["scope", "table", "query"])
            let scope = try scope(request), table = try table(request)
            let query: [String: Any]
            if let raw = request["query"] { guard let value = raw as? [String: Any] else { throw invalid() }; query = value } else { query = [:] }
            try keys(query, allowed: ["ids", "entityKey", "keysOnly"])
            let ids: [String]?
            if let raw = query["ids"] {
                guard let value = raw as? [String], value.count <= 10_000 else { throw Failure.invalid("Too many or invalid requested library rows.") }
                try value.forEach(validateID)
                // Swift String equality folds canonically equivalent Unicode; server IDs do not.
                var unique: [Data: String] = [:]
                for id in value { unique[Data(id.utf8)] = id }
                ids = unique.values.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }
            } else { ids = nil }
            let entity: String?
            if let raw = query["entityKey"] {
                guard table == "outbox", let value = raw as? String, value.utf8.count <= 32768 else { throw Failure.invalid("entityKey is only valid for outbox queries.") }; entity = value
            } else { entity = nil }
            let keysOnly = try boolean(query, "keysOnly", fallback: false)
            return try transaction(write: false) {
                let revision = try self.revision(scope, table)
                if ids?.isEmpty == true { return ["revision": String(revision), "rows": []] }
                // Batch IN lists below SQLite's conservative parameter limit. One read transaction keeps the same snapshot.
                let batches: [[String]?] = ids.map { values in stride(from: 0, to: values.count, by: 400).map { Array(values[$0..<min($0 + 400, values.count)]) } } ?? [nil]
                var rows: [[String: Any]] = [], bytes = 0
                for batch in batches {
                    var sql = "SELECT \(keysOnly ? "row_key,id" : "json,id") FROM records WHERE scope=? AND table_name=?"
                    var binds: [Bind] = [.text(scope), .text(table)]
                    if let entity { sql += " AND entity_key=?"; binds.append(.text(entity)) }
                    if let batch { sql += " AND id IN (" + Array(repeating: "?", count: batch.count).joined(separator: ",") + ")"; binds += batch.map(Bind.text) }
                    sql += " ORDER BY id"
                    try statement(sql, binds) { cursor in
                        while try step(cursor) {
                            let content = try text(cursor, 0), id = try text(cursor, 1)
                            bytes += content.utf8.count
                            guard bytes <= Self.batchBytes, rows.count < Self.maxRows else { throw Failure.invalid("The library snapshot is too large; request rows in batches.") }
                            if keysOnly { rows.append(["key": content, "scope": scope, "id": id]) }
                            else {
                                guard let value = try JSONSerialization.jsonObject(with: Data(content.utf8)) as? [String: Any] else { throw Failure.storage }
                                rows.append(value)
                            }
                        }
                    }
                }
                return ["revision": String(revision), "rows": rows]
            }
        }
    }
    func commit(_ request: [String: Any]) throws -> [String: Any] {
        try locked {
            try keys(request, allowed: ["scope", "expected", "mutations"])
            let scope = try scope(request)
            guard let expected = request["expected"] as? [String: Any], let mutations = request["mutations"] as? [[String: Any]], mutations.count <= Self.maxRows else { throw invalid() }
            var revisions: [String: Int64] = [:], changed = Set<String>(), bytes = 0
            for (table, raw) in expected {
                guard Self.tables.contains(table), let value = raw as? String, let parsed = Int64(value), parsed >= 0, String(parsed) == value else { throw Failure.invalid("Invalid library revision.") }
                revisions[table] = parsed
            }
            for mutation in mutations {
                let table = try table(mutation), type = try string(mutation, "type")
                guard revisions[table] != nil else { throw Failure.invalid("Every changed table requires an expected revision.") }
                changed.insert(table)
                switch type {
                case "put":
                    try keys(mutation, allowed: ["type", "table", "row"])
                    guard let row = mutation["row"] as? [String: Any] else { throw invalid() }
                    _ = try validateRow(scope, row)
                    let encoded = try json(row)
                    guard encoded.utf8.count <= Self.rowBytes else { throw Failure.invalid("Library record is too large.") }
                    bytes += encoded.utf8.count
                case "delete": try keys(mutation, allowed: ["type", "table", "id"]); try validateID(string(mutation, "id"))
                case "clear": try keys(mutation, allowed: ["type", "table"])
                default: throw invalid()
                }
            }
            guard bytes <= Self.batchBytes else { throw Failure.invalid("Library transaction is too large.") }
            return try transaction(write: true) {
                for (table, expected) in revisions { if try self.revision(scope, table) != expected { return ["committed": false] } }
                for mutation in mutations {
                    let table = try table(mutation)
                    switch try string(mutation, "type") {
                    case "put":
                        guard let row = mutation["row"] as? [String: Any] else { throw invalid() }
                        let id = try validateRow(scope, row), key = try string(row, "key")
                        let blob = table == "localFiles" ? try validateReference(scope, row) : nil
                        let entity = table == "outbox" ? row["entityKey"] as? String : nil
                        try update("INSERT OR REPLACE INTO records(scope,table_name,id,row_key,json,entity_key,blob_id) VALUES(?,?,?,?,?,?,?)", [.text(scope), .text(table), .text(id), .text(key), .text(try json(row)), entity.map(Bind.text) ?? .null, blob.map(Bind.text) ?? .null])
                    case "delete": try update("DELETE FROM records WHERE scope=? AND table_name=? AND id=?", [.text(scope), .text(table), .text(try string(mutation, "id"))])
                    case "clear": try update("DELETE FROM records WHERE scope=? AND table_name=?", [.text(scope), .text(table)])
                    default: throw invalid()
                    }
                }
                for table in changed {
                    let previous = try self.revision(scope, table)
                    guard previous < Int64.max else { throw Failure.invalid("Library revision capacity exceeded.") }
                    try update("INSERT OR REPLACE INTO revisions(scope,table_name,revision) VALUES(?,?,?)", [.text(scope), .text(table), .number(previous + 1)])
                }
                return ["committed": true]
            }
        }
    }

    func beginBlob(_ request: [String: Any], epoch: UInt64) throws -> [String: Any] {
        try locked {
            try keys(request, allowed: ["scope", "size", "mime", "name"])
            let scope = try scope(request), size = try integer(request, "size"), mime = try string(request, "mime"), name = try string(request, "name")
            try validateFile(size, mime, name)
            guard let epoch = Int64(exactly: epoch) else { throw invalid() }
            try cleanup()
            let id = UUID().uuidString.lowercased(), path = blobPath(id, finished: false)
            do {
                return try transaction(write: true) {
                    let count = try scalar("SELECT COUNT(*) FROM blobs"), pending = try scalar("SELECT COUNT(*) FROM blobs WHERE state=0"), bytes = try scalar("SELECT COALESCE(SUM(size),0) FROM blobs")
                    guard count < 4096, pending < 4, bytes <= Self.totalBytes - size else { throw Failure.invalid("Native file storage has reached its capacity.") }
                    try createFile(path)
                    try update("INSERT INTO blobs(id,scope,size,mime,name,state,offset,created_at,process_id,epoch) VALUES(?,?,?,?,?,0,0,?,?,?)", [.text(id), .text(scope), .number(size), .text(mime), .text(name), .number(now()), .text(processID), .number(epoch)])
                    try syncDirectory(path.deletingLastPathComponent())
                    return ["id": id]
                }
            } catch { try? FileManager.default.removeItem(at: path); throw error }
        }
    }
    func appendBlob(_ request: [String: Any], epoch: UInt64) throws {
        try locked {
            try keys(request, allowed: ["scope", "id", "offset", "dataBase64"])
            let scope = try scope(request), id = try handle(request, "id"), offset = try integer(request, "offset"), raw = try string(request, "dataBase64")
            guard raw.utf8.count <= 4 * ((Self.chunkBytes + 2) / 3), let bytes = Data(base64Encoded: raw), bytes.base64EncodedString() == raw, !bytes.isEmpty, bytes.count <= Self.chunkBytes else { throw Failure.invalid("Native file chunks must contain 1 to 256 KiB of base64 data.") }
            try transaction(write: true) {
                let record = try blobRecord(scope, id)
                try pending(record, epoch)
                guard offset == record.offset, offset <= record.size - Int64(bytes.count) else { throw Failure.invalid("Native file chunks must be appended at the exact next offset.") }
                let path = blobPath(id, finished: false)
                try requireFile(path, size: offset)
                let file = try FileHandle(forWritingTo: path); defer { try? file.close() }
                try file.seek(toOffset: UInt64(offset)); try file.write(contentsOf: bytes); try file.synchronize()
                try update("UPDATE blobs SET offset=?,created_at=? WHERE id=?", [.number(offset + Int64(bytes.count)), .number(now()), .text(id)])
            }
        }
    }
    func finishBlob(_ request: [String: Any], epoch: UInt64) throws -> [String: Any] {
        try locked {
            try keys(request, allowed: ["scope", "id"])
            let scope = try scope(request), id = try handle(request, "id")
            return try transaction(write: true) {
                let record = try blobRecord(scope, id)
                if record.state == 1, record.processID == processID, UInt64(exactly: record.epoch) == epoch {
                    try requireFile(blobPath(id, finished: true), size: record.size); return record.reference
                }
                try pending(record, epoch)
                guard record.offset == record.size else { throw Failure.invalid("The native file transfer is incomplete.") }
                let part = blobPath(id, finished: false), destination = blobPath(id, finished: true)
                try requireFile(part, size: record.size)
                guard try !regularOptional(destination) else { throw Failure.invalid("The native file destination already exists.") }
                let file = try FileHandle(forWritingTo: part); defer { try? file.close() }; try file.synchronize()
                try FileManager.default.moveItem(at: part, to: destination)
                try syncDirectory(destination.deletingLastPathComponent())
                try update("UPDATE blobs SET state=1,created_at=? WHERE id=?", [.number(now()), .text(id)])
                return record.reference
            }
        }
    }
    func readBlob(_ request: [String: Any]) throws -> [String: Any] {
        try locked {
            try keys(request, allowed: ["scope", "blobId", "offset", "length"])
            let scope = try scope(request), id = try handle(request, "blobId"), offset = try integer(request, "offset"), length = try integer(request, "length")
            guard length > 0, length <= Self.chunkBytes else { throw Failure.invalid("Native file reads require 1 to 256 KiB.") }
            return try transaction(write: true) {
                let record = try blobRecord(scope, id)
                guard record.state == 1, offset <= record.size else { throw Failure.invalid("Invalid native file receipt or read offset.") }
                let path = blobPath(id, finished: true)
                try requireFile(path, size: record.size)
                let file = try FileHandle(forReadingFrom: path); defer { try? file.close() }
                try file.seek(toOffset: UInt64(offset))
                let count = Int(min(length, record.size - offset)); var data = Data()
                while data.count < count {
                    guard let part = try file.read(upToCount: count - data.count), !part.isEmpty else { throw Failure.storage }; data.append(part)
                }
                // Verification extends the grace period for a finished, not-yet-published migration receipt.
                try update("UPDATE blobs SET created_at=? WHERE id=?", [.number(now()), .text(id)])
                return ["dataBase64": data.base64EncodedString(), "done": offset + Int64(count) == record.size]
            }
        }
    }
    func cancelBlob(_ request: [String: Any]) throws {
        try locked {
            try keys(request, allowed: ["scope", "id"])
            let scope = try scope(request), id = try handle(request, "id")
            let removed = try transaction(write: true) {
                try update("DELETE FROM blobs WHERE id=? AND scope=? AND state=0", [.text(id), .text(scope)])
                return sqlite3_changes(database) > 0
            }
            if removed { try removeFiles(id) }
        }
    }

    private func cleanup() throws {
        let cutoff = max(0, now() - Self.ttl)
        let expired: [String] = try transaction(write: true) {
            var ids: [String] = []
            try statement("SELECT id FROM blobs WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM records WHERE records.blob_id=blobs.id)", [.number(cutoff)]) { cursor in
                while try step(cursor) { ids.append(try text(cursor, 0)) }
            }
            for id in ids { try update("DELETE FROM blobs WHERE id=?", [.text(id)]) }
            return ids
        }
        for id in expired { try removeFiles(id) }
        // Failed file/SQL commits may leave an opaque orphan; never follow links or accept supplied paths.
        let folder = directory.appendingPathComponent("blobs", isDirectory: true)
        for path in try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey]) {
            let id = path.deletingPathExtension().lastPathComponent
            guard UUID(uuidString: id)?.uuidString.lowercased() == id, ["part", "bin"].contains(path.pathExtension), try regularOptional(path) else { continue }
            let values = try FileManager.default.attributesOfItem(atPath: path.path)
            guard let date = values[.modificationDate] as? Date, date.timeIntervalSince1970 * 1000 < Double(cutoff) else { continue }
            if try scalar("SELECT COUNT(*) FROM blobs WHERE id=?", [.text(id)]) == 0 { try FileManager.default.removeItem(at: path) }
        }
        try syncDirectory(folder)
    }
    private func removeFiles(_ id: String) throws {
        for finished in [false, true] { let path = blobPath(id, finished: finished); if try regularOptional(path) { try FileManager.default.removeItem(at: path) } }
        try syncDirectory(directory.appendingPathComponent("blobs", isDirectory: true))
    }
    private func blobRecord(_ scope: String, _ id: String) throws -> BlobRecord {
        try statement("SELECT size,mime,name,state,offset,created_at,process_id,epoch FROM blobs WHERE id=? AND scope=?", [.text(id), .text(scope)]) { cursor in
            guard try step(cursor) else { throw Failure.invalid("The native file receipt does not belong to this library.") }
            return BlobRecord(id: id, scope: scope, size: sqlite3_column_int64(cursor, 0), mime: try text(cursor, 1), name: try text(cursor, 2), state: sqlite3_column_int64(cursor, 3), offset: sqlite3_column_int64(cursor, 4), updatedAt: sqlite3_column_int64(cursor, 5), processID: try text(cursor, 6), epoch: sqlite3_column_int64(cursor, 7))
        }
    }
    private func pending(_ record: BlobRecord, _ epoch: UInt64) throws {
        guard record.state == 0, record.processID == processID, UInt64(exactly: record.epoch) == epoch, now() - record.updatedAt <= Self.ttl else { throw Failure.invalid("This native file transfer expired or belongs to an earlier connection.") }
    }
    private func validateReference(_ scope: String, _ row: [String: Any]) throws -> String {
        guard let value = row["value"] as? [String: Any], Set(value.keys) == Set(["name", "blob"]), let reference = value["blob"] as? [String: Any], Set(reference.keys) == Set(["blobId", "size", "mime", "name"]) else { throw Failure.invalid("Local files require only a name and native blob receipt.") }
        let id = try handle(reference, "blobId"), size = try integer(reference, "size"), mime = try string(reference, "mime"), name = try string(reference, "name")
        let record = try blobRecord(scope, id)
        guard record.state == 1, record.size == size, sameBytes(record.mime, mime), sameBytes(record.name, name), let valueName = value["name"] as? String, sameBytes(valueName, name) else { throw Failure.invalid("Native file metadata does not match its immutable receipt.") }
        try requireFile(blobPath(id, finished: true), size: size)
        return id
    }

    /// JSON.stringify-compatible compact quoting, including unescaped slashes and Unicode separators.
    static func identity(_ values: [String]) -> String {
        "[" + values.map { value in
            var result = "\""
            for scalar in value.unicodeScalars {
                switch scalar.value {
                case 0x22: result += "\\\""
                case 0x5c: result += "\\\\"
                case 8: result += "\\b"
                case 9: result += "\\t"
                case 10: result += "\\n"
                case 12: result += "\\f"
                case 13: result += "\\r"
                case 0..<32: result += String(format: "\\u%04x", scalar.value)
                default: result.unicodeScalars.append(scalar)
                }
            }
            return result + "\""
        }.joined(separator: ",") + "]"
    }
    private func scope(_ value: [String: Any]) throws -> String {
        let scope = try string(value, "scope")
        guard scope.utf8.count <= 32768, let pair = try? JSONSerialization.jsonObject(with: Data(scope.utf8)) as? [String], pair.count == 2, sameBytes(Self.identity(pair), scope),
              var url = URLComponents(string: pair[0]), ["http", "https"].contains(url.scheme ?? ""), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw Failure.invalid("Invalid library account scope.") }
        guard !url.percentEncodedPath.split(separator: "/").contains(where: { part in
            let decoded = String(part).removingPercentEncoding
            return decoded == "." || decoded == ".."
        }) else { throw Failure.invalid("Invalid library account scope.") }
        url.scheme = url.scheme?.lowercased(); url.host = host.lowercased()
        if (url.scheme == "http" && url.port == 80) || (url.scheme == "https" && url.port == 443) { url.port = nil }
        guard var normalized = url.url?.absoluteString else { throw invalid() }
        while normalized.hasSuffix("/") { normalized.removeLast() }
        if normalized.hasSuffix("/api/v1") { normalized = String(normalized.dropLast(7)) }
        guard sameBytes(normalized, pair[0]) else { throw Failure.invalid("Invalid library account scope.") }
        try validateID(pair[1]); return scope
    }
    private func table(_ value: [String: Any]) throws -> String {
        let table = try string(value, "table"); guard Self.tables.contains(table) else { throw invalid() }; return table
    }
    private func validateID(_ value: String) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.utf8.count <= 8192, !value.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else { throw Failure.invalid("Invalid library row identity.") }
    }
    private func validateRow(_ scope: String, _ row: [String: Any]) throws -> String {
        let id = try string(row, "id"); try validateID(id)
        guard let rowScope = row["scope"] as? String, let key = row["key"] as? String,
              sameBytes(rowScope, scope), sameBytes(key, Self.identity([scope, id])) else { throw Failure.invalid("Library rows must match their scoped identity.") }; return id
    }
    private func handle(_ value: [String: Any], _ key: String) throws -> String {
        let id = try string(value, key)
        guard id.count == 36, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw Failure.invalid("Invalid native file handle.") }; return id
    }
    private func validateFile(_ size: Int64, _ mime: String, _ name: String) throws {
        guard size <= Self.fileBytes, mime.utf8.count <= 1024, name.utf8.count <= 4096, !name.isEmpty,
              !mime.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }), !name.unicodeScalars.contains(where: { $0.properties.generalCategory == .control }) else { throw Failure.invalid("Invalid native file size or metadata.") }
    }
    private func keys(_ value: [String: Any], allowed: Set<String>) throws { guard Set(value.keys).isSubset(of: allowed) else { throw invalid() } }
    private func string(_ value: [String: Any], _ key: String) throws -> String { guard let text = value[key] as? String else { throw invalid() }; return text }
    private func integer(_ value: [String: Any], _ key: String) throws -> Int64 {
        guard let number = value[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite, number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991, number.doubleValue.rounded(.towardZero) == number.doubleValue else { throw invalid() }; return number.int64Value
    }
    private func boolean(_ value: [String: Any], _ key: String, fallback: Bool) throws -> Bool {
        guard let raw = value[key] else { return fallback }
        guard let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw invalid() }; return number.boolValue
    }
    private func json(_ value: [String: Any]) throws -> String {
        guard JSONSerialization.isValidJSONObject(value), let text = String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8) else { throw invalid() }; return text
    }
    private func invalid() -> Failure { .invalid("Invalid native library request.") }
    private func sameBytes(_ first: String, _ second: String) -> Bool { first.utf8.elementsEqual(second.utf8) }
    private func blobPath(_ id: String, finished: Bool) -> URL { directory.appendingPathComponent("blobs", isDirectory: true).appendingPathComponent(id + (finished ? ".bin" : ".part")) }
    private func privateDirectory(_ url: URL) throws {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) { try manager.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
        let attrs = try manager.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeDirectory else { throw Failure.storage }
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
        #if os(iOS)
        try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        var path = url, values = URLResourceValues(); values.isExcludedFromBackup = true; try path.setResourceValues(values)
        #endif
    }
    private func regularOptional(_ url: URL) throws -> Bool {
        let attrs: [FileAttributeKey: Any]
        do { attrs = try FileManager.default.attributesOfItem(atPath: url.path) }
        catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoSuchFileError { return false }
        guard attrs[.type] as? FileAttributeType == .typeRegular else { throw Failure.storage }
        return true
    }
    private func requireFile(_ url: URL, size: Int64) throws {
        guard try regularOptional(url), (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value == size else { throw Failure.invalid("The native file is missing or incomplete.") }
    }
    private func createFile(_ url: URL) throws {
        let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, mode_t(0o600))
        guard fd >= 0 else { throw Failure.storage }; defer { _ = close(fd) }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
        guard fsync(fd) == 0 else { throw Failure.storage }
    }
    private func syncDirectory(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure.storage }; defer { _ = close(fd) }
        guard fsync(fd) == 0 else { throw Failure.storage }
    }
    private func locked<T>(_ action: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try action() }
    private func transaction<T>(write: Bool, _ action: () throws -> T) throws -> T {
        try execute(write ? "BEGIN IMMEDIATE" : "BEGIN")
        do { let value = try action(); try execute("COMMIT"); return value }
        catch { try? execute("ROLLBACK"); throw error }
    }
    private func execute(_ sql: String) throws { guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw Failure.storage } }
    private func statement<T>(_ sql: String, _ binds: [Bind] = [], _ action: (OpaquePointer) throws -> T) throws -> T {
        var pointer: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &pointer, nil) == SQLITE_OK, let pointer else { throw Failure.storage }; defer { sqlite3_finalize(pointer) }
        for (index, value) in binds.enumerated() {
            let status: Int32
            switch value {
            case .text(let text): status = sqlite3_bind_text(pointer, Int32(index + 1), text, Int32(text.utf8.count), transient)
            case .number(let number): status = sqlite3_bind_int64(pointer, Int32(index + 1), number)
            case .null: status = sqlite3_bind_null(pointer, Int32(index + 1))
            }
            guard status == SQLITE_OK else { throw Failure.storage }
        }
        return try action(pointer)
    }
    private func update(_ sql: String, _ binds: [Bind] = []) throws { try statement(sql, binds) { guard sqlite3_step($0) == SQLITE_DONE else { throw Failure.storage } } }
    private func scalar(_ sql: String, _ binds: [Bind] = []) throws -> Int64 { try statement(sql, binds) { try step($0) ? sqlite3_column_int64($0, 0) : 0 } }
    private func revision(_ scope: String, _ table: String) throws -> Int64 { try scalar("SELECT revision FROM revisions WHERE scope=? AND table_name=?", [.text(scope), .text(table)]) }
    private func step(_ cursor: OpaquePointer) throws -> Bool { let result = sqlite3_step(cursor); guard result == SQLITE_ROW || result == SQLITE_DONE else { throw Failure.storage }; return result == SQLITE_ROW }
    private func text(_ cursor: OpaquePointer, _ column: Int32) throws -> String { guard let text = sqlite3_column_text(cursor, column) else { throw Failure.storage }; return String(cString: text) }
}

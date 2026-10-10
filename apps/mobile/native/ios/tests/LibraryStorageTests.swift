import Foundation
import SQLite3

/// Execute against the same Foundation/SQLite backend compiled into iOS, without Capacitor or mocks:
/// swiftc AvidLibraryStorage.swift tests/LibraryStorageTests.swift -o /tmp/avid-library-tests && /tmp/avid-library-tests
@main
struct LibraryStorageTests {
    struct TestFailure: Error, CustomStringConvertible { let description: String }
    static let a = AvidLibraryStorage.identity(["https://books.example", "reader-a"])
    static let b = AvidLibraryStorage.identity(["https://books.example", "reader-b"])
    static func expect(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
        if try !condition() { throw TestFailure(description: message) }
    }
    static func rejects(_ message: String, _ action: () throws -> Void) throws {
        do { try action() } catch { return }; throw TestFailure(description: "Expected rejection: " + message)
    }
    static func withStore(_ action: (AvidLibraryStorage, URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("avid-library-test-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try action(AvidLibraryStorage(directory: directory), directory)
    }
    static func row(_ scope: String = a, _ id: String = "one", _ value: [String: Any] = ["title": "Book"]) -> [String: Any] {
        ["key": AvidLibraryStorage.identity([scope, id]), "scope": scope, "id": id, "value": value]
    }
    static func put(_ table: String = "books", _ row: [String: Any] = row()) -> [String: Any] { ["type": "put", "table": table, "row": row] }
    static func commit(_ store: AvidLibraryStorage, _ scope: String = a, _ expected: [String: String], _ mutations: [[String: Any]]) throws -> Bool {
        try store.commit(["scope": scope, "expected": expected, "mutations": mutations])["committed"] as? Bool == true
    }
    static func read(_ store: AvidLibraryStorage, _ table: String = "books", _ scope: String = a, query: [String: Any] = [:]) throws -> (String, [[String: Any]]) {
        let result = try store.read(["scope": scope, "table": table, "query": query])
        guard let revision = result["revision"] as? String, let rows = result["rows"] as? [[String: Any]] else { throw TestFailure(description: "Malformed read result") }
        return (revision, rows)
    }
    static func start(_ store: AvidLibraryStorage, _ size: Int, scope: String = a, epoch: UInt64 = 2) throws -> String {
        let result = try store.beginBlob(["scope": scope, "size": size, "mime": "application/epub+zip", "name": "chapter.epub"], epoch: epoch)
        guard let id = result["id"] as? String else { throw TestFailure(description: "Missing transfer identity") }; return id
    }
    static func append(_ store: AvidLibraryStorage, _ id: String, _ data: Data, offset: Int = 0, scope: String = a, epoch: UInt64 = 2) throws {
        try store.appendBlob(["scope": scope, "id": id, "offset": offset, "dataBase64": data.base64EncodedString()], epoch: epoch)
    }
    static func finish(_ store: AvidLibraryStorage, _ id: String, scope: String = a, epoch: UInt64 = 2) throws -> [String: Any] {
        try store.finishBlob(["scope": scope, "id": id], epoch: epoch)
    }
    static func nativeSQL(_ directory: URL, _ sql: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open(directory.appendingPathComponent("library.sqlite3").path, &database) == SQLITE_OK else { throw TestFailure(description: "Opening test database") }
        defer { sqlite3_close(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw TestFailure(description: "Writing test database") }
    }

    static func main() throws {
        let tests: [(String, () throws -> Void)] = [
            ("isolates every table by account and persists across reopen", {
                try withStore { store, directory in
                    for table in AvidLibraryStorage.tables where table != "localFiles" {
                        try expect(commit(store, a, [table: "0"], [put(table, row(a))]), "initial account write")
                        try expect(commit(store, b, [table: "0"], [put(table, row(b, "one", ["other": true]))]), "second account write")
                    }
                    let reopened = try AvidLibraryStorage(directory: directory)
                    for table in AvidLibraryStorage.tables where table != "localFiles" {
                        let (_, rows) = try read(reopened, table)
                        try expect(rows.count == 1 && rows[0]["scope"] as? String == a, "persisted scoped rows")
                    }
                }
            }),
            ("validates exact canonical JSON identity and rejects unknown protocol fields", {
                try withStore { store, _ in
                    let identity = "slash/ quote\" backslash\\ 中文 é 🦊 \u{2028}", scoped = AvidLibraryStorage.identity(["https://books.example", "用户\"\\"])
                    try expect(AvidLibraryStorage.identity(["/", "\"", "\\", "\u{2028}"]) == "[\"/\",\"\\\"\",\"\\\\\",\"\u{2028}\"]", "JS-compatible escaping")
                    try expect(commit(store, scoped, ["books": "0"], [put("books", row(scoped, identity))]), "Unicode identity accepted")
                    let composed = "\u{00e9}", decomposed = "e\u{0301}"
                    try expect(commit(store, a, ["books": "0"], [put("books", row(a, composed)), put("books", row(a, decomposed))]), "distinct Unicode byte identities")
                    try expect(read(store, "books", query: ["ids": [composed, decomposed]]).1.count == 2, "query dedup must not fold Unicode identities")
                    var wrong = row(); wrong["key"] = AvidLibraryStorage.identity([b, "one"])
                    try rejects("wrong key") { _ = try commit(store, a, ["books": "1"], [put("books", wrong)]) }
                    try rejects("cross-account row") { _ = try commit(store, a, ["books": "1"], [put("books", row(b))]) }
                    wrong = row(a, composed); wrong["key"] = AvidLibraryStorage.identity([a, decomposed])
                    try rejects("canonically equivalent but byte-different key") { _ = try commit(store, a, ["books": "1"], [put("books", wrong)]) }
                    try rejects("uncanonical scope") { _ = try read(store, "books", "[ \"https://books.example\",\"reader-a\"]") }
                    try rejects("HTTP credential URL") { _ = try read(store, "books", AvidLibraryStorage.identity(["https://user:pass@books.example", "a"])) }
                    try rejects("unnormalized dot path") { _ = try read(store, "books", AvidLibraryStorage.identity(["https://books.example/a/%2e%2e/b", "a"])) }
                    try rejects("unknown table") { _ = try read(store, "sqlite_master") }
                    try rejects("unknown request field") { _ = try store.read(["scope": a, "table": "books", "path": "/tmp/anything"]) }
                }
            }),
            ("CAS checks all tables and empty snapshots without partial mutations", {
                try withStore { store, directory in
                    let second = try AvidLibraryStorage(directory: directory)
                    try expect(commit(store, a, ["books": "0"], [put()]), "first commit")
                    try expect(!commit(second, a, ["books": "0", "anchors": "0"], [put("anchors")]), "stale revision rejected")
                    try expect(read(second, "anchors").1.isEmpty, "failed CAS did not write another table")
                    try expect(!commit(second, a, ["books": "0"], []), "empty commit validates snapshot")
                    try expect(commit(second, a, ["books": "1"], []), "valid empty snapshot")
                    try expect(read(store).0 == "1", "empty snapshot does not advance revision")
                    try rejects("missing changed-table expected revision") { _ = try commit(store, a, [:], [put()]) }
                    try rejects("noncanonical revision") { _ = try commit(store, a, ["books": "01"], []) }
                }
            }),
            ("rolls back earlier mutations when a later file receipt is invalid", {
                try withStore { store, _ in
                    let invalidFile = row(a, "file", ["name": "chapter.epub", "blob": ["blobId": UUID().uuidString.lowercased(), "size": 0, "mime": "", "name": "chapter.epub"]])
                    try rejects("missing receipt") { _ = try commit(store, a, ["books": "0", "localFiles": "0"], [put(), put("localFiles", invalidFile)]) }
                    try expect(read(store).1.isEmpty && read(store).0 == "0", "metadata and revision rollback")
                }
            }),
            ("preserves ordered mutations and revisions through account clearing", {
                try withStore { store, _ in
                    try expect(commit(store, a, ["books": "0"], [put(), ["type": "clear", "table": "books"], put("books", row(a, "last"))]), "ordered commit")
                    try expect(read(store).1.map { $0["id"] as? String } == ["last"], "clear executes in order")
                    try expect(commit(store, b, ["books": "0"], [put("books", row(b))]), "other account")
                    try expect(commit(store, a, ["books": "1"], [["type": "clear", "table": "books"]]), "clear")
                    try expect(read(store).0 == "2" && read(store).1.isEmpty, "revision survives clear")
                    try expect(read(store, "books", b).1.count == 1, "clear preserves other account")
                    try expect(!commit(store, a, ["books": "0"], [put()]), "old snapshot cannot become valid after clear")
                }
            }),
            ("supports exact ids, empty ids, outbox entity filter, and metadata-only reads", {
                try withStore { store, _ in
                    var one = row(a, "a"); one["entityKey"] = "book:1"
                    var two = row(a, "b"); two["entityKey"] = "book:2\u{0000}suffix"
                    try expect(commit(store, a, ["outbox": "0"], [put("outbox", one), put("outbox", two)]), "outbox commit")
                    try expect(read(store, "outbox", query: ["ids": []]).1.isEmpty, "empty ids")
                    try expect(read(store, "outbox", query: ["ids": ["a", "b"], "entityKey": "book:1"]).1.count == 1, "combined filters")
                    try expect(read(store, "outbox", query: ["entityKey": "book:2\u{0000}suffix"]).1.count == 1, "embedded NUL retains exact filter bytes")
                    try expect(read(store, "outbox", query: ["entityKey": "book:2"]).1.isEmpty, "embedded NUL is not truncated")
                    let metadata = try read(store, "outbox", query: ["keysOnly": true]).1
                    try expect(metadata.count == 2 && metadata.allSatisfy { Set($0.keys) == Set(["key", "scope", "id"]) }, "keysOnly projection")
                    try rejects("entity filter on wrong table") { _ = try read(store, "books", query: ["entityKey": "book:1"]) }
                }
            }),
            ("round-trips bounded file chunks before and after atomic publication", {
                try withStore { store, directory in
                    let bytes = Data((0..<(AvidLibraryStorage.chunkBytes + 7)).map { UInt8($0 % 251) })
                    let id = try start(store, bytes.count)
                    try append(store, id, bytes.prefix(AvidLibraryStorage.chunkBytes))
                    try append(store, id, bytes.suffix(7), offset: AvidLibraryStorage.chunkBytes)
                    let reference = try finish(store, id)
                    try expect(try finish(store, id)["blobId"] as? String == id, "finish retry is idempotent")
                    let first = try store.readBlob(["scope": a, "blobId": id, "offset": 0, "length": AvidLibraryStorage.chunkBytes])
                    let last = try store.readBlob(["scope": a, "blobId": id, "offset": AvidLibraryStorage.chunkBytes, "length": 100])
                    try expect(Data(base64Encoded: first["dataBase64"] as! String) == bytes.prefix(AvidLibraryStorage.chunkBytes), "first chunk exact")
                    try expect(Data(base64Encoded: last["dataBase64"] as! String) == bytes.suffix(7) && last["done"] as? Bool == true, "last chunk exact EOF")
                    try expect(commit(store, a, ["localFiles": "0", "books": "0"], [put(), put("localFiles", row(a, "edition", ["name": "chapter.epub", "blob": reference]))]), "atomic edition publication")
                    try store.cancelBlob(["scope": a, "id": id])
                    let reopened = try AvidLibraryStorage(directory: directory)
                    try expect(read(reopened, "localFiles").1.count == 1, "receipt persists")
                    try expect(reopened.readBlob(["scope": a, "blobId": id, "offset": bytes.count, "length": 1])["done"] as? Bool == true, "immutable file survives cancel and restart")
                }
            }),
            ("rejects incomplete, reordered, oversized, malformed and cross-account chunks", {
                try withStore { store, _ in
                    let id = try start(store, 3)
                    try rejects("premature finish") { _ = try finish(store, id) }
                    try rejects("offset jump") { try append(store, id, Data([1]), offset: 1) }
                    try rejects("wrong account") { try append(store, id, Data([1]), scope: b) }
                    try rejects("oversized chunk") { try append(store, id, Data(repeating: 1, count: AvidLibraryStorage.chunkBytes + 1)) }
                    try rejects("invalid base64") { try store.appendBlob(["scope": a, "id": id, "offset": 0, "dataBase64": "???="], epoch: 2) }
                    try append(store, id, Data([1, 2, 3])); _ = try finish(store, id)
                    try rejects("wrong account file read") { _ = try store.readBlob(["scope": b, "blobId": id, "offset": 0, "length": 1]) }
                    try rejects("read > chunk limit") { _ = try store.readBlob(["scope": a, "blobId": id, "offset": 0, "length": AvidLibraryStorage.chunkBytes + 1]) }
                    try rejects("path instead of handle") { _ = try store.readBlob(["scope": a, "blobId": "../../outside", "offset": 0, "length": 1]) }
                }
            }),
            ("binds pending transfers to connection epoch and process, retaining old-account metadata", {
                try withStore { store, directory in
                    let id = try start(store, 1)
                    try rejects("changed epoch") { try append(store, id, Data([1]), epoch: 3) }
                    let reopened = try AvidLibraryStorage(directory: directory)
                    try rejects("changed process") { try append(reopened, id, Data([1])) }
                    try expect(commit(store, a, ["anchors": "0"], [put("anchors")]), "final old-account checkpoint remains writable")
                    try store.cancelBlob(["scope": b, "id": id])
                    try append(store, id, Data([1])); let receipt = try finish(store, id)
                    try rejects("different scope reference") { _ = try commit(store, b, ["localFiles": "0"], [put("localFiles", row(b, "edition", ["name": "chapter.epub", "blob": receipt]))]) }
                    try expect(store.readBlob(["scope": a, "blobId": id, "offset": 0, "length": 1])["done"] as? Bool == true, "finished references survive epoch")
                }
            }),
            ("validates physical size and exact immutable receipt metadata", {
                try withStore { store, directory in
                    let id = try start(store, 1); try append(store, id, Data([42])); let receipt = try finish(store, id)
                    var changed = receipt; changed["name"] = "other.epub"
                    try rejects("different file metadata") { _ = try commit(store, a, ["localFiles": "0"], [put("localFiles", row(a, "one", ["name": "other.epub", "blob": changed]))]) }
                    let path = directory.appendingPathComponent("blobs/" + id + ".bin")
                    let file = try FileHandle(forWritingTo: path); try file.truncate(atOffset: 0); try file.close()
                    try rejects("truncated receipt") { _ = try store.readBlob(["scope": a, "blobId": id, "offset": 0, "length": 1]) }
                    try rejects("publication of missing bytes") { _ = try commit(store, a, ["localFiles": "0"], [put("localFiles", row(a, "one", ["name": "chapter.epub", "blob": receipt]))]) }
                }
            }),
            ("accepts zero-byte files and enforces file, quota and parallel-transfer bounds", {
                try withStore { store, _ in
                    let empty = try start(store, 0); _ = try finish(store, empty)
                    try expect(store.readBlob(["scope": a, "blobId": empty, "offset": 0, "length": 1])["dataBase64"] as? String == "", "empty exact bytes")
                    try rejects("file >4GiB") { _ = try start(store, Int(AvidLibraryStorage.fileBytes + 1)) }
                    let first = try start(store, Int(AvidLibraryStorage.fileBytes)), second = try start(store, Int(AvidLibraryStorage.fileBytes))
                    try rejects("8GiB reservation quota") { _ = try start(store, 1) }
                    try store.cancelBlob(["scope": a, "id": first]); try store.cancelBlob(["scope": a, "id": second])
                    for _ in 0..<4 { _ = try start(store, 0) }
                    try rejects("fifth pending transfer") { _ = try start(store, 0) }
                }
            }),
            ("expires unreferenced receipts but retains published files and read grace", {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("avid-library-ttl-" + UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: directory) }
                var time: Int64 = 10_000_000
                let store = try AvidLibraryStorage(directory: directory, now: { time })
                let published = try start(store, 0), orphan = try start(store, 0), verifying = try start(store, 0)
                let reference = try finish(store, published); _ = try finish(store, orphan); _ = try finish(store, verifying)
                try expect(commit(store, a, ["localFiles": "0"], [put("localFiles", row(a, "one", ["name": "chapter.epub", "blob": reference]))]), "publish")
                time += 3_599_000
                _ = try store.readBlob(["scope": a, "blobId": verifying, "offset": 0, "length": 1])
                time += 2_000
                _ = try start(store, 0) // runs bounded cleanup
                try rejects("unreferenced expired file") { _ = try store.readBlob(["scope": a, "blobId": orphan, "offset": 0, "length": 1]) }
                try expect(store.readBlob(["scope": a, "blobId": published, "offset": 0, "length": 1])["done"] as? Bool == true, "published file survives TTL")
                try expect(store.readBlob(["scope": a, "blobId": verifying, "offset": 0, "length": 1])["done"] as? Bool == true, "successful read extends unpublished grace")
            }),
            ("keeps metadata-only file listing independent from missing binary bytes", {
                try withStore { store, directory in
                    let id = try start(store, 0), reference = try finish(store, id)
                    try expect(commit(store, a, ["localFiles": "0"], [put("localFiles", row(a, "one", ["name": "chapter.epub", "blob": reference]))]), "publish")
                    try FileManager.default.removeItem(at: directory.appendingPathComponent("blobs/" + id + ".bin"))
                    try expect(read(store, "localFiles", query: ["keysOnly": true]).1.count == 1, "metadata listing does not open file")
                    try rejects("binary read detects missing file") { _ = try store.readBlob(["scope": a, "blobId": id, "offset": 0, "length": 1]) }
                }
            }),
            ("refuses symlinked private directories and unsupported schema versions", {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent("avid-library-path-" + UUID().uuidString)
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                defer { try? FileManager.default.removeItem(at: root) }
                let actual = root.appendingPathComponent("actual"), link = root.appendingPathComponent("linked")
                try FileManager.default.createDirectory(at: actual, withIntermediateDirectories: true)
                try FileManager.default.createSymbolicLink(at: link, withDestinationURL: actual)
                try rejects("symlink store directory") { _ = try AvidLibraryStorage(directory: link) }
                do { _ = try AvidLibraryStorage(directory: actual) }
                try nativeSQL(actual, "PRAGMA user_version=99")
                try rejects("future schema") { _ = try AvidLibraryStorage(directory: actual) }
            }),
            ("rejects unsafe number types and oversized rows without mutating SQLite", {
                try withStore { store, _ in
                    try rejects("boolean size") { _ = try store.beginBlob(["scope": a, "size": true, "mime": "", "name": "a"], epoch: 2) }
                    try rejects("fractional size") { _ = try store.beginBlob(["scope": a, "size": 1.5, "mime": "", "name": "a"], epoch: 2) }
                    try rejects("negative size") { _ = try start(store, -1) }
                    try rejects("oversized row") { _ = try commit(store, a, ["books": "0"], [put("books", row(a, "one", ["text": String(repeating: "a", count: 8 * 1024 * 1024)]))]) }
                    try expect(read(store).0 == "0", "limits leave database unchanged")
                }
            })
        ]
        for (name, test) in tests { try test(); print("PASS " + name) }
        print("\(tests.count) native SQLite/file tests passed.")
    }
}

import Capacitor
import Foundation
import SQLite3

/// Durable metadata only. Events retain their IDs until the scoped JS transaction acknowledges them.
@MainActor
final class AvidPlaybackJournal {
    static let shared = AvidPlaybackJournal()
    private(set) var recoveryError: String?
    private var database: OpaquePointer?
    private var previous: Sample?
    private var activity: Activity?
    private var needsFlush = false
    private var lastProgress: String?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private struct Sample {
        let scope: String, bookId: String, fileId: String, revision: String
        let position: Double, rate: Double, monotonic: Double
        let wall: Date, playing: Bool, readOnly: Bool
        var identity: [String] { [scope, bookId, fileId, revision, readOnly ? "read-only" : "writable"] }
    }
    private struct Activity {
        let source: Sample, startedAt: Date
        var duration: Double
    }
    enum JournalError: LocalizedError {
        case invalidRequest, wrongAccount, storage
        var errorDescription: String? {
            switch self {
            case .invalidRequest: return "A valid account scope and at most 200 journal IDs are required."
            case .wrongAccount: return "A journal event belongs to a different account."
            case .storage: return "The native playback journal could not be stored."
            }
        }
    }
    private static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
    private static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
    private func open() throws -> OpaquePointer {
        if let database { return database }
        let root = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var directory = root.appendingPathComponent("AvidPlaybackJournal", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        var attributes = URLResourceValues(); attributes.isExcludedFromBackup = true
        try directory.setResourceValues(attributes)
        var handle: OpaquePointer?
        guard sqlite3_open_v2(directory.appendingPathComponent("events.sqlite").path, &handle,
            SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }; throw JournalError.storage
        }
        do {
            try execute(handle, "PRAGMA journal_mode=WAL")
            try execute(handle, "PRAGMA synchronous=FULL")
            try execute(handle, "CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, account_scope TEXT NOT NULL, book_id TEXT NOT NULL, file_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('progress','activity')), created_at TEXT NOT NULL, payload TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 1)")
            try execute(handle, "CREATE INDEX IF NOT EXISTS events_scope_sequence ON events(account_scope, sequence)")
            database = handle
            return handle
        } catch { sqlite3_close(handle); throw error }
    }
    private func execute(_ handle: OpaquePointer, _ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw JournalError.storage }
    }
    private func statement<T>(_ sql: String, strings: [String] = [], body: (OpaquePointer) throws -> T) throws -> T {
        let handle = try open()
        var prepared: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &prepared, nil) == SQLITE_OK, let prepared else { throw JournalError.storage }
        defer { sqlite3_finalize(prepared) }
        for (index, value) in strings.enumerated() {
            guard sqlite3_bind_text(prepared, Int32(index + 1), value, -1, transient) == SQLITE_OK else { throw JournalError.storage }
        }
        return try body(prepared)
    }
    private func insert(scope: String, bookId: String, fileId: String, type: String, createdAt: String, payload: [String: Any], readOnly: Bool, id: String = UUID().uuidString.lowercased()) throws {
        do {
        let bytes = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        guard let text = String(data: bytes, encoding: .utf8) else { throw JournalError.storage }
        try statement("INSERT INTO events(id, account_scope, book_id, file_id, event_type, created_at, payload, read_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            strings: [id, scope, bookId, fileId, type, createdAt, text, readOnly ? "1" : "0"]) { value in
            guard sqlite3_step(value) == SQLITE_DONE else { throw JournalError.storage }
        }
        recoveryError = nil
        } catch {
            recoveryError = "Playback continues, but progress and listening time could not be saved on this device. Keep Avid open until storage recovers."
            throw error
        }
    }
    private func readSample(_ value: [String: Any]) -> Sample? {
        guard let scope = value["accountScope"] as? String, !scope.isEmpty, scope.count <= 4096,
              let book = value["bookId"] as? String, !book.isEmpty, book.count <= 512,
              let file = value["fileId"] as? String, !file.isEmpty, file.count <= 512,
              let position = value["position"] as? Double, position.isFinite, position >= 0 else { return nil }
        let rate = (value["rate"] as? NSNumber)?.doubleValue ?? 1
        guard rate.isFinite, rate > 0, rate <= 4 else { return nil }
        let status = value["status"] as? String
        return Sample(scope: scope, bookId: book, fileId: file, revision: value["manifestRevision"] as? String ?? "",
            position: position, rate: rate, monotonic: ProcessInfo.processInfo.systemUptime, wall: Date(),
            playing: value["playing"] as? Bool == true && (status == nil || status == "playing"), readOnly: value["readOnly"] as? Bool ?? true)
    }
    func recordProgress(_ value: [String: Any]) throws {
        guard let source = readSample(value), let track = value["trackId"] as? String, !track.isEmpty, track.count <= 512,
              let trackTime = value["trackTime"] as? Double, trackTime.isFinite, trackTime >= 0,
              let updatedAt = value["updatedAt"] as? String, Self.date(updatedAt) != nil else { return }
        var locator: [String: Any] = ["version": 1, "trackId": track, "trackTime": trackTime, "time": source.position]
        if !source.revision.isEmpty { locator["manifestRevision"] = source.revision }
        let bytes = try JSONSerialization.data(withJSONObject: locator, options: [.sortedKeys])
        guard let text = String(data: bytes, encoding: .utf8) else { throw JournalError.storage }
        let fingerprint = source.identity + [text]
        let key = String(data: try JSONSerialization.data(withJSONObject: fingerprint), encoding: .utf8)
        if key == lastProgress { return }
        let duration = value["duration"] as? Double ?? 0
        let progress = duration.isFinite && duration > 0 ? min(1, source.position / duration) : 0
        try insert(scope: source.scope, bookId: source.bookId, fileId: source.fileId, type: "progress", createdAt: updatedAt,
            payload: ["bookId": source.bookId, "fileId": source.fileId, "kind": "audio", "locator": text, "progress": progress, "updatedAt": updatedAt], readOnly: source.readOnly)
        lastProgress = key
    }
    /// Call before any seek/source replacement with flush(), then resume sampling after the operation.
    func sample(_ value: [String: Any]) throws {
        if needsFlush { previous = nil; try flushActivity() }
        guard let current = readSample(value) else { try flush(); return }
        defer { previous = current }
        guard let prior = previous else { return }
        let elapsed = current.monotonic - prior.monotonic
        let delta = current.position - prior.position
        let expected = elapsed * prior.rate
        guard current.identity == prior.identity, current.playing, prior.playing,
              current.rate == prior.rate, elapsed > 0, elapsed <= 2,
              delta > 0, abs(delta - expected) <= max(0.25, expected * 0.5),
              current.wall >= prior.wall else { try flushActivity(); return }
        var remaining = elapsed
        var intervalStart = prior.wall
        while remaining > 0.000001 {
            if activity == nil { activity = Activity(source: prior, startedAt: intervalStart, duration: 0) }
            let portion = min(remaining, 15 - (activity?.duration ?? 0))
            activity?.duration += portion
            remaining -= portion; intervalStart = intervalStart.addingTimeInterval(portion)
            if (activity?.duration ?? 0) >= 15 - 0.000001 { try flushActivity() }
        }
    }
    private func flushActivity() throws {
        guard let activity, activity.duration > 0 else { self.activity = nil; return }
        needsFlush = true
        let id = UUID().uuidString.lowercased()
        let ended = Self.timestamp(activity.startedAt.addingTimeInterval(activity.duration))
        try insert(scope: activity.source.scope, bookId: activity.source.bookId, fileId: activity.source.fileId, type: "activity", createdAt: ended,
            payload: ["id": id, "bookId": activity.source.bookId, "kind": "listening", "startedAt": Self.timestamp(activity.startedAt),
                "duration": min(15, activity.duration), "endedAt": ended], readOnly: activity.source.readOnly, id: id)
        self.activity = nil
        needsFlush = false
    }
    func flush() throws { previous = nil; try flushActivity() }

    func recordAnchor(accountScope: String, anchor: [String: Any], readOnly: Bool) throws -> String {
        guard !accountScope.isEmpty, accountScope.count <= 4096,
              let bookId = anchor["bookId"] as? String, !bookId.isEmpty, bookId.count <= 512,
              let fileId = anchor["fileId"] as? String, !fileId.isEmpty, fileId.count <= 512,
              let kind = anchor["kind"] as? String, ["epub", "pdf", "comic", "audio"].contains(kind),
              let locator = anchor["locator"] as? String, !locator.isEmpty, locator.utf8.count <= 65536,
              let progress = anchor["progress"] as? Double, progress.isFinite, (0...1).contains(progress),
              let updatedAt = anchor["updatedAt"] as? String, Self.date(updatedAt) != nil else { throw JournalError.invalidRequest }
        if kind == "audio" {
            guard let value = try? JSONSerialization.jsonObject(with: Data(locator.utf8)) as? [String: Any],
                  value["version"] as? Int == 1, let track = value["trackId"] as? String, !track.isEmpty,
                  let trackTime = value["trackTime"] as? Double, trackTime.isFinite, trackTime >= 0,
                  let time = value["time"] as? Double, time.isFinite, time >= 0 else { throw JournalError.invalidRequest }
        }
        let id = UUID().uuidString.lowercased()
        try insert(scope: accountScope, bookId: bookId, fileId: fileId, type: "progress", createdAt: updatedAt,
            payload: ["bookId": bookId, "fileId": fileId, "kind": kind, "locator": locator, "progress": progress, "updatedAt": updatedAt], readOnly: readOnly, id: id)
        return id
    }

    func drain(accountScope: String, limit: Int = 200) throws -> [[String: Any]] {
        guard !accountScope.isEmpty, accountScope.count <= 4096, (1...200).contains(limit) else { throw JournalError.invalidRequest }
        return try statement("SELECT id, account_scope, book_id, file_id, event_type, created_at, payload, read_only FROM events WHERE account_scope = ? ORDER BY sequence LIMIT \(limit)", strings: [accountScope]) { value in
            var events: [[String: Any]] = []
            while true {
                let step = sqlite3_step(value)
                if step == SQLITE_DONE { return events }
                guard step == SQLITE_ROW else { throw JournalError.storage }
                let fields = (0..<7).map { String(cString: sqlite3_column_text(value, Int32($0))) }
                let payload = try JSONSerialization.jsonObject(with: Data(fields[6].utf8))
                events.append(["id": fields[0], "accountScope": fields[1], "bookId": fields[2], "fileId": fields[3], "type": fields[4], "createdAt": fields[5], "payload": payload, "readOnly": sqlite3_column_int(value, 7) != 0])
            }
        }
    }
    func ack(accountScope: String, ids: [String]) throws {
        guard !accountScope.isEmpty, accountScope.count <= 4096, ids.count <= 200,
              Set(ids).count == ids.count, ids.allSatisfy({ !$0.isEmpty && $0.count <= 128 }) else { throw JournalError.invalidRequest }
        let handle = try open()
        try execute(handle, "BEGIN IMMEDIATE")
        do {
            for id in ids {
                try statement("SELECT account_scope FROM events WHERE id = ?", strings: [id]) { value in
                    let result = sqlite3_step(value)
                    guard result == SQLITE_ROW || result == SQLITE_DONE else { throw JournalError.storage }
                    if result == SQLITE_ROW, String(cString: sqlite3_column_text(value, 0)) != accountScope { throw JournalError.wrongAccount }
                }
            }
            for id in ids {
                try statement("DELETE FROM events WHERE id = ? AND account_scope = ?", strings: [id, accountScope]) { value in
                    guard sqlite3_step(value) == SQLITE_DONE else { throw JournalError.storage }
                }
            }
            try execute(handle, "COMMIT")
        } catch { try? execute(handle, "ROLLBACK"); throw error }
    }
}

@objc(AvidJournalPlugin)
public class AvidJournalPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidJournalPlugin"
    public let jsName = "AvidJournal"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "drain", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "ack", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "recordProgress", returnType: CAPPluginReturnPromise)]
    @objc func recordProgress(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let saved = try AvidSessionStore.read()
                guard let session = saved["session"] as? [String: Any], let profile = session["profile"] as? [String: Any],
                      var url = profile["url"] as? String, let user = session["userId"] as? String,
                      let scope = call.getString("accountScope"), let anchor = call.getObject("anchor") else { throw AvidPlaybackJournal.JournalError.invalidRequest }
                while url.hasSuffix("/") { url.removeLast() }
                if url.hasSuffix("/api/v1") { url = String(url.dropLast(7)) }
                let identity = try JSONSerialization.jsonObject(with: Data(scope.utf8)) as? [String]
                guard identity == [url, user] else { throw AvidPlaybackJournal.JournalError.wrongAccount }
                let readOnly = call.getBool("readOnly") != false || (saved["readOnly"] as? Bool) != false
                let id = try AvidPlaybackJournal.shared.recordAnchor(accountScope: scope, anchor: anchor, readOnly: readOnly)
                call.resolve(["id": id, "readOnly": readOnly])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func drain(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let events = try AvidPlaybackJournal.shared.drain(accountScope: call.getString("accountScope") ?? "", limit: call.getInt("limit") ?? 200)
                call.resolve(["events": events])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func ack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                guard let ids = call.getArray("ids", String.self) else { throw AvidPlaybackJournal.JournalError.invalidRequest }
                try AvidPlaybackJournal.shared.ack(accountScope: call.getString("accountScope") ?? "", ids: ids)
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
}

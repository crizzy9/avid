import CryptoKit
import Foundation

struct AvidRecentBook: Codable, Hashable, Identifiable {
    let scopeHash: String
    let bookId: String
    let fileId: String
    var title: String
    var author: String
    var kind: String
    var progress: Double
    var audioPosition: Double?
    var audioDuration: Double?
    var isPlaying: Bool
    var updatedAt: Date

    var id: String {
        let bytes = (try? JSONEncoder().encode([scopeHash, bookId, fileId])) ?? Data()
        return bytes.base64EncodedString()
    }
    var deepLink: URL? {
        var components = URLComponents()
        components.scheme = "avid"
        components.host = "resume"
        components.queryItems = [URLQueryItem(name: "id", value: id)]
        return components.url
    }
}

enum AvidSurfaceError: LocalizedError {
    case appGroupUnavailable, unavailableBook, expiredSource, noAudioSource, mainAppRequired, invalidInput
    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable: return "The Avid App Group is not enabled for this signed app."
        case .unavailableBook: return "This book is not available in the currently signed-in account. Open Avid to continue."
        case .expiredSource: return "The saved audio access has expired. Open Avid to refresh it."
        case .noAudioSource: return "Open this audiobook in Avid once before resuming it from a system control."
        case .mainAppRequired: return "The audio intent must run in Avid's app process."
        case .invalidInput: return "The system action is missing a valid book identity."
        }
    }
}

/// Shared metadata only. Credentials and streaming URLs never enter the widget container.
final class AvidSharedStore {
    static let shared = AvidSharedStore()
    static let groupID = "group.app.avid.reader"
    static let widgetKind = "AvidContinueReading"
    static let controlKind = "AvidResumeAudio"

    var isAvailable: Bool {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: Self.groupID) != nil
    }
    private var defaults: UserDefaults? { isAvailable ? UserDefaults(suiteName: Self.groupID) : nil }
    var activeScopeHash: String? { defaults?.string(forKey: "activeScope") }

    static func scopeHash(_ accountScope: String) -> String {
        SHA256.hash(data: Data(accountScope.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    @discardableResult
    func activate(accountScope: String) throws -> String? {
        guard !accountScope.isEmpty else { throw AvidSurfaceError.invalidInput }
        guard let defaults else { throw AvidSurfaceError.appGroupUnavailable }
        let old = activeScopeHash
        defaults.set(Self.scopeHash(accountScope), forKey: "activeScope")
        if old != activeScopeHash { defaults.removeObject(forKey: "pendingNavigation") }
        return old
    }

    func recentBooks() -> [AvidRecentBook] {
        guard let scope = activeScopeHash, let data = defaults?.data(forKey: "recent.\(scope)"),
              let values = try? JSONDecoder().decode([AvidRecentBook].self, from: data) else { return [] }
        return values.filter { $0.scopeHash == scope }.sorted { $0.updatedAt > $1.updatedAt }
    }

    func book(id: String?) throws -> AvidRecentBook {
        guard isAvailable else { throw AvidSurfaceError.appGroupUnavailable }
        let values = recentBooks()
        if let book = id == nil ? values.first : values.first(where: { $0.id == id }) { return book }
        if let id, let scope = activeScopeHash, let data = defaults?.data(forKey: "book.\(scope).\(id)"),
           let book = try? JSONDecoder().decode(AvidRecentBook.self, from: data), book.scopeHash == scope { return book }
        throw AvidSurfaceError.unavailableBook
    }

    func save(_ book: AvidRecentBook) throws {
        guard let defaults else { throw AvidSurfaceError.appGroupUnavailable }
        guard book.scopeHash == activeScopeHash, !book.bookId.isEmpty, !book.fileId.isEmpty,
              book.progress.isFinite, (0...1).contains(book.progress) else { throw AvidSurfaceError.invalidInput }
        var values = recentBooks().filter { $0.id != book.id }
        values.insert(book, at: 0)
        defaults.set(try JSONEncoder().encode(Array(values.prefix(8))), forKey: "recent.\(book.scopeHash)")
        try saveIndexedBook(book)
    }
    func saveIndexedBook(_ book: AvidRecentBook) throws {
        guard let defaults else { throw AvidSurfaceError.appGroupUnavailable }
        guard book.scopeHash == activeScopeHash else { throw AvidSurfaceError.unavailableBook }
        defaults.set(try JSONEncoder().encode(book), forKey: "book.\(book.scopeHash).\(book.id)")
    }

    func enqueueNavigation(id: String) throws {
        let book = try self.book(id: id)
        defaults?.set(book.id, forKey: "pendingNavigation")
    }
    func consumeNavigation() -> AvidRecentBook? {
        guard let id = defaults?.string(forKey: "pendingNavigation") else { return nil }
        defaults?.removeObject(forKey: "pendingNavigation")
        return try? book(id: id)
    }
    func remove(ids: [String]) throws {
        guard let defaults, let scope = activeScopeHash else { throw AvidSurfaceError.appGroupUnavailable }
        let removed = Set(ids)
        defaults.set(try JSONEncoder().encode(recentBooks().filter { !removed.contains($0.id) }), forKey: "recent.\(scope)")
        ids.forEach { defaults.removeObject(forKey: "book.\(scope).\($0)") }
        if let id = defaults.string(forKey: "pendingNavigation"), removed.contains(id) { defaults.removeObject(forKey: "pendingNavigation") }
    }
    func clearActiveAccount() {
        if let scope = activeScopeHash {
            defaults?.removeObject(forKey: "recent.\(scope)")
            defaults?.dictionaryRepresentation().keys.filter { $0.hasPrefix("book.\(scope).") }.forEach { defaults?.removeObject(forKey: $0) }
        }
        defaults?.removeObject(forKey: "activeScope")
        defaults?.removeObject(forKey: "pendingNavigation")
    }
}

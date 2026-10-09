import AppIntents
import Foundation

@available(iOS 17.0, *)
struct AvidBookEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Avid book")
    static var defaultQuery = AvidBookQuery()
    let id: String
    let title: String
    let author: String
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(author)") }
    init(_ book: AvidRecentBook) { id = book.id; title = book.title; author = book.author }
}

@available(iOS 17.0, *)
struct AvidBookQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AvidBookEntity] {
        identifiers.compactMap { id in (try? AvidSharedStore.shared.book(id: id)).map(AvidBookEntity.init) }
    }
    func suggestedEntities() async throws -> [AvidBookEntity] { AvidSharedStore.shared.recentBooks().map(AvidBookEntity.init) }
}

@available(iOS 17.0, *)
struct ResumeAvidAudioIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "Resume Avid audio"
    static var description = IntentDescription("Resume a recent audiobook using Avid's native audio owner.")
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    @Parameter(title: "Book") var book: AvidBookEntity?
    init() {}
    init(book: AvidBookEntity) { self.book = book }
    func perform() async throws -> some IntentResult {
        #if AVID_WIDGET_EXTENSION
        // AudioPlaybackIntent is executed from this type's app-target definition.
        // Fail explicitly if a target/configuration error runs it in the extension.
        throw AvidSurfaceError.mainAppRequired
        #else
        let selected = try AvidSharedStore.shared.book(id: book?.id)
        guard selected.kind == "audio" else { throw AvidSurfaceError.noAudioSource }
        try await AvidPlaybackOwner.shared.resume(selected)
        #endif
        return .result()
    }
}

@available(iOS 17.0, *)
struct PauseAvidAudioIntent: AudioPlaybackIntent {
    static var title: LocalizedStringResource = "Pause Avid audio"
    static var openAppWhenRun = false
    static var authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    @Parameter(title: "Book") var book: AvidBookEntity?
    init() {}
    init(book: AvidBookEntity) { self.book = book }
    func perform() async throws -> some IntentResult {
        #if AVID_WIDGET_EXTENSION
        throw AvidSurfaceError.mainAppRequired
        #else
        try await MainActor.run { try AvidPlaybackOwner.shared.pause(AvidSharedStore.shared.book(id: book?.id)) }
        #endif
        return .result()
    }
}

@available(iOS 17.0, *)
struct ContinueAvidBookIntent: AppIntent {
    static var title: LocalizedStringResource = "Continue reading in Avid"
    static var openAppWhenRun = true
    @Parameter(title: "Book") var book: AvidBookEntity?
    init() {}
    init(book: AvidBookEntity) { self.book = book }
    func perform() async throws -> some IntentResult {
        #if AVID_WIDGET_EXTENSION
        throw AvidSurfaceError.mainAppRequired
        #else
        try await MainActor.run {
            let selected = try AvidSharedStore.shared.book(id: book?.id)
            guard AvidSystemSurfaces.openBook(id: selected.id) else { throw AvidSurfaceError.unavailableBook }
        }
        #endif
        return .result()
    }
}

#if !AVID_WIDGET_EXTENSION
@available(iOS 17.0, *)
struct AvidShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ResumeAvidAudioIntent(), phrases: ["Resume audio in \(.applicationName)"], shortTitle: "Resume audio", systemImageName: "play.fill")
        AppShortcut(intent: PauseAvidAudioIntent(), phrases: ["Pause audio in \(.applicationName)"], shortTitle: "Pause audio", systemImageName: "pause.fill")
        AppShortcut(intent: ContinueAvidBookIntent(), phrases: ["Continue reading in \(.applicationName)"], shortTitle: "Continue reading", systemImageName: "book")
    }
}
#endif

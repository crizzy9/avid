import CoreSpotlight
import Foundation
import UIKit
import UniformTypeIdentifiers
import WidgetKit

@MainActor
enum AvidSystemSurfaces {
    static let catalogNotification = Notification.Name("app.avid.native-catalog")
    static let navigationNotification = Notification.Name("app.avid.native-navigation")

    static func refresh() {
        NotificationCenter.default.post(name: catalogNotification, object: nil)
        let books = AvidSharedStore.shared.recentBooks()
        UIApplication.shared.shortcutItems = Array(books.prefix(4)).map { book in
            UIApplicationShortcutItem(type: "app.avid.resume-book", localizedTitle: "Continue \(book.title)",
                localizedSubtitle: book.author,
                icon: UIApplicationShortcutIcon(systemImageName: book.kind == "audio" ? "headphones" : "book"),
                userInfo: ["id": book.id as NSString])
        }
        WidgetCenter.shared.reloadTimelines(ofKind: AvidSharedStore.widgetKind)
        if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: AvidSharedStore.controlKind) }
    }

    static func index(_ books: [AvidRecentBook], completion: @escaping (Error?) -> Void) {
        guard let scope = AvidSharedStore.shared.activeScopeHash,
              books.allSatisfy({ $0.scopeHash == scope }) else { completion(AvidSurfaceError.unavailableBook); return }
        let items = books.map { book -> CSSearchableItem in
            let attributes = CSSearchableItemAttributeSet(contentType: book.kind == "audio" ? .audio : .text)
            attributes.title = book.title
            attributes.authorNames = book.author.isEmpty ? [] : [book.author]
            attributes.contentDescription = book.kind == "audio" ? "Continue listening in Avid" : "Continue reading in Avid"
            attributes.contentURL = book.deepLink
            return CSSearchableItem(uniqueIdentifier: book.id, domainIdentifier: "avid.\(scope)", attributeSet: attributes)
        }
        CSSearchableIndex.default().indexSearchableItems(items, completionHandler: completion)
    }

    static func removeAccount(_ scope: String, completion: @escaping (Error?) -> Void) {
        CSSearchableIndex.default().deleteSearchableItems(withDomainIdentifiers: ["avid.\(scope)"], completionHandler: completion)
    }
    static func removeBooks(_ ids: [String], completion: @escaping (Error?) -> Void) {
        CSSearchableIndex.default().deleteSearchableItems(withIdentifiers: ids, completionHandler: completion)
    }
    @discardableResult
    static func openBook(id: String) -> Bool {
        do {
            try AvidSharedStore.shared.enqueueNavigation(id: id)
            NotificationCenter.default.post(name: navigationNotification, object: nil)
            return true
        } catch { return false }
    }
    @discardableResult
    static func handle(url: URL) -> Bool {
        guard url.scheme == "avid", url.host == "resume", let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let id = components.queryItems?.first(where: { $0.name == "id" })?.value else { return false }
        return openBook(id: id)
    }
    @discardableResult
    static func handle(activity: NSUserActivity) -> Bool {
        guard activity.activityType == CSSearchableItemActionType,
              let id = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return false }
        return openBook(id: id)
    }
    @discardableResult
    static func handle(shortcut: UIApplicationShortcutItem) -> Bool {
        guard shortcut.type == "app.avid.resume-book", let id = shortcut.userInfo?["id"] as? String else { return false }
        return openBook(id: id)
    }
}

import Capacitor
import CoreSpotlight
import Foundation
import UIKit

@objc(AvidSystemSurfacesPlugin)
public class AvidSystemSurfacesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidSystemSurfacesPlugin"
    public let jsName = "AvidSystemSurfaces"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activateAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "publishRecent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "indexBooks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeBooks", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearAccount", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeNavigation", returnType: CAPPluginReturnPromise)
    ]
    private var navigationObserver: NSObjectProtocol?
    public override func load() {
        navigationObserver = NotificationCenter.default.addObserver(forName: AvidSystemSurfaces.navigationNotification,
            object: nil, queue: .main) { [weak self] _ in
                // Wake JS without consuming: cold-start routing stays durable until JS asks for it.
                self?.notifyListeners("navigationAvailable", data: [:])
            }
    }
    deinit { if let navigationObserver { NotificationCenter.default.removeObserver(navigationObserver) } }

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var intents = false; var controls = false
            if #available(iOS 17.0, *) { intents = true }
            if #available(iOS 18.0, *) { controls = true }
            let embedded = Bundle.main.builtInPlugInsURL.map {
                FileManager.default.fileExists(atPath: $0.appendingPathComponent("AvidWidgets.appex").path)
            } ?? false
            call.resolve(["appGroupAvailable": AvidSharedStore.shared.isAvailable,
                "spotlightAvailable": CSSearchableIndex.isIndexingAvailable(),
                "widgetExtensionEmbedded": embedded, "audioIntentsAvailable": intents,
                "controlsAvailable": controls && embedded])
        }
    }
    @objc func activateAccount(_ call: CAPPluginCall) {
        guard let scope = call.getString("accountScope"), !scope.isEmpty else { call.reject("An account scope is required."); return }
        DispatchQueue.main.async {
            do {
                let old = AvidSharedStore.shared.activeScopeHash
                let next = AvidSharedStore.scopeHash(scope)
                if let old, old != next {
                    AvidPlaybackOwner.shared.clear()
                    AvidPlaybackSourceStore.removeAccount(scopeHash: old)
                    AvidSharedStore.shared.clearActiveAccount()
                    AvidSystemSurfaces.removeAccount(old) { _ in }
                }
                try AvidSharedStore.shared.activate(accountScope: scope)
                AvidSystemSurfaces.refresh()
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func publishRecent(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                guard let value = call.getObject("book") else { throw AvidSurfaceError.invalidInput }
                let book = try self.decode(value, scope: call.getString("accountScope"))
                try AvidSharedStore.shared.save(book)
                AvidSystemSurfaces.refresh()
                call.resolve(["id": book.id])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func indexBooks(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                guard let values = call.getArray("books", JSObject.self), values.count <= 500 else { throw AvidSurfaceError.invalidInput }
                let books = try values.map { try self.decode($0, scope: call.getString("accountScope")) }
                // Metadata enables account-checked Spotlight/deep-link lookup beyond recent items.
                try books.forEach { try AvidSharedStore.shared.saveIndexedBook($0) }
                AvidSystemSurfaces.index(books) { error in
                    if let error { call.reject(error.localizedDescription) } else { call.resolve(["ids": books.map(\.id)]) }
                }
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func removeBooks(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                guard let ids = call.getArray("ids", String.self) else { throw AvidSurfaceError.invalidInput }
                // Reject requests to remove another account's identifiers.
                try ids.forEach { _ = try AvidSharedStore.shared.book(id: $0) }
                try AvidSharedStore.shared.remove(ids: ids)
                AvidSystemSurfaces.refresh()
                AvidSystemSurfaces.removeBooks(ids) { error in
                    if let error { call.reject(error.localizedDescription) } else { call.resolve() }
                }
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func clearAccount(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let scope = AvidSharedStore.shared.activeScopeHash
            AvidPlaybackOwner.shared.clear()
            if let scope { AvidPlaybackSourceStore.removeAccount(scopeHash: scope) }
            AvidSharedStore.shared.clearActiveAccount()
            AvidSystemSurfaces.refresh()
            if let scope {
                AvidSystemSurfaces.removeAccount(scope) { error in
                    if let error { call.reject(error.localizedDescription) } else { call.resolve() }
                }
            } else { call.resolve() }
        }
    }
    @objc func consumeNavigation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let book = AvidSharedStore.shared.consumeNavigation() {
                call.resolve(["book": ["scopeHash": book.scopeHash, "bookId": book.bookId, "fileId": book.fileId, "kind": book.kind]])
            } else { call.resolve([:]) }
        }
    }
    private func decode(_ value: JSObject, scope: String?) throws -> AvidRecentBook {
        guard let scope, AvidSharedStore.scopeHash(scope) == AvidSharedStore.shared.activeScopeHash,
              let bookId = value["bookId"] as? String, !bookId.isEmpty,
              let fileId = value["fileId"] as? String, !fileId.isEmpty,
              let title = value["title"] as? String, let kind = value["kind"] as? String,
              ["epub", "pdf", "comic", "audio"].contains(kind),
              let progress = value["progress"] as? Double, progress.isFinite, (0...1).contains(progress) else { throw AvidSurfaceError.invalidInput }
        let position = value["audioPosition"] as? Double
        let duration = value["audioDuration"] as? Double
        guard [position, duration].allSatisfy({ $0 == nil || ($0!.isFinite && $0! >= 0) }) else { throw AvidSurfaceError.invalidInput }
        return AvidRecentBook(scopeHash: AvidSharedStore.scopeHash(scope), bookId: bookId, fileId: fileId,
            title: title, author: value["author"] as? String ?? "", kind: kind, progress: progress,
            audioPosition: position, audioDuration: duration, isPlaying: false, updatedAt: Date())
    }
}

import CarPlay
import UIKit

/// Compiled source only in standard builds; the App-CarPlay scheme opts into scene registration.
/// Distribution still requires Apple's approved audio entitlement and physical qualification.
@MainActor
final class AvidCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private var library: CPListTemplate?
    private var observer: NSObjectProtocol?

    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didConnect interfaceController: CPInterfaceController) {
        self.interfaceController = interfaceController
        let root = CPListTemplate(title: "Avid", sections: sections())
        library = root
        CPNowPlayingTemplate.shared.isUpNextButtonEnabled = false
        CPNowPlayingTemplate.shared.isAlbumArtistButtonEnabled = false
        interfaceController.setRootTemplate(root, animated: false, completion: nil)
        observer = NotificationCenter.default.addObserver(forName: AvidSystemSurfaces.catalogNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }
    func templateApplicationScene(_ templateApplicationScene: CPTemplateApplicationScene, didDisconnect interfaceController: CPInterfaceController) {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        library = nil
        self.interfaceController = nil
        // Disconnecting the car does not discard the native owner or its checkpoint.
    }
    private func refresh() { library?.updateSections(sections()) }
    private func sections() -> [CPListSection] {
        guard AvidSharedStore.shared.activeScopeHash != nil else {
            return [CPListSection(items: [CPListItem(text: "Open Avid to sign in", detailText: "Connect your book server on your phone while parked.")])]
        }
        let recent = AvidSharedStore.shared.recentBooks().filter { $0.kind == "audio" }
        let all = AvidSharedStore.shared.catalogBooks().filter { $0.kind == "audio" }
        let prepared = all.filter { (try? AvidPlaybackSourceStore.source(for: $0)) != nil }
        guard !prepared.isEmpty else {
            return [CPListSection(items: [CPListItem(text: "No prepared audiobooks", detailText: "Open an audiobook in Avid on your phone before driving.")])]
        }
        let recentIDs = Set(recent.map(\.id))
        let first = recent.filter { candidate in prepared.contains(where: { $0.id == candidate.id }) }
        let rest = prepared.filter { !recentIDs.contains($0.id) }.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        var result: [CPListSection] = []
        if !first.isEmpty { result.append(CPListSection(items: first.map(row), header: "Continue listening", sectionIndexTitle: nil)) }
        if !rest.isEmpty { result.append(CPListSection(items: Array(rest.prefix(100)).map(row), header: "Prepared audiobooks", sectionIndexTitle: nil)) }
        return result
    }
    private func row(_ book: AvidRecentBook) -> CPListItem {
        let row = CPListItem(text: book.title, detailText: book.author)
        row.handler = { [weak self] _, completion in
            Task { @MainActor in
                defer { completion() }
                do {
                    // Re-resolve after selection: account switches cannot reuse the visible row's authority.
                    let current = try AvidSharedStore.shared.book(id: book.id)
                    try await AvidPlaybackOwner.shared.resume(current)
                    self?.interfaceController?.pushTemplate(CPNowPlayingTemplate.shared, animated: true, completion: nil)
                } catch {
                    let action = CPAlertAction(title: "OK", style: .default) { [weak self] _ in self?.interfaceController?.dismissTemplate(animated: true, completion: nil) }
                    let alert = CPAlertTemplate(titleVariants: ["Unable to play. Open Avid on your phone while parked to refresh access."], actions: [action])
                    self?.interfaceController?.presentTemplate(alert, animated: true, completion: nil)
                }
            }
        }
        return row
    }
}

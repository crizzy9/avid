import Capacitor
import Foundation
import CarPlay
import UIKit
import WebKit

@objc(AvidPlaybackPlugin)
public class AvidPlaybackPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidPlaybackPlugin"
    public let jsName = "AvidPlayback"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configureRemote", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setRate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSleepTimer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "snapshot", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]

    public override func load() {
        DispatchQueue.main.async {
            AvidPlaybackOwner.shared.onCheckpoint = { [weak self] value in self?.notifyListeners("checkpoint", data: value) }
        }
    }

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            _ = AvidPlaybackOwner.shared // Registers the process-owned remote command handlers.
            let modes = Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String] ?? []
            // iOS has no public general-purpose runtime entitlement query. An actual system-created
            // CarPlay scene proves entitlement and host support; an opt-in source flag does not.
            let car = UIApplication.shared.connectedScenes.contains { $0 is CPTemplateApplicationScene }
            call.resolve(["backgroundAudioAvailable": modes.contains("audio"),
                "systemMediaControlsAvailable": true, "carIntegrationAvailable": car])
        }
    }

    @objc func load(_ call: CAPPluginCall) {
        guard let rawURL = call.getString("url"), let url = URL(string: rawURL),
              let scope = call.getString("accountScope"), let bookId = call.getString("bookId"),
              let fileId = call.getString("fileId") else { call.reject("Missing playback identity or URL."); return }
        Task { @MainActor in
            let generation = AvidSharedStore.shared.accountGeneration
            let cookieStore = self.webView?.configuration.websiteDataStore.httpCookieStore ?? WKWebsiteDataStore.default().httpCookieStore
            let cookies = await cookieStore.allCookies()
            do {
                let tracks = try call.getArray("tracks", JSObject.self)?.map { value -> AvidAudioTrack in
                    guard let id = value["id"] as? String, let raw = value["url"] as? String, let url = URL(string: raw) else { throw AvidPlaybackOwner.PlaybackError.invalidTimeline }
                    return AvidAudioTrack(id: id, url: url, duration: value["duration"] as? Double)
                }
                let chapters = try call.getArray("chapters", JSObject.self)?.map { value -> AvidAudioChapter in
                    guard let id = value["id"] as? String, let title = value["title"] as? String,
                          let start = value["start"] as? Double, let duration = value["duration"] as? Double else { throw AvidPlaybackOwner.PlaybackError.invalidTimeline }
                    return AvidAudioChapter(id: id, title: title, start: start, duration: duration)
                } ?? []
                if generation != AvidSharedStore.shared.accountGeneration && AvidSharedStore.shared.activeScopeHash != AvidSharedStore.scopeHash(scope) { throw AvidSurfaceError.unavailableBook }
                try AvidPlaybackOwner.shared.load(scope: scope, bookId: bookId, fileId: fileId, url: url,
                    title: call.getString("title") ?? "", author: call.getString("author") ?? "",
                    position: call.getDouble("position") ?? 0, rate: Float(call.getDouble("rate") ?? 1),
                    expiresAt: call.getString("expiresAt").flatMap { ISO8601DateFormatter().date(from: $0) }, cookies: cookies, tracks: tracks, manifestRevision: call.getString("manifestRevision"), readOnly: call.getBool("readOnly") ?? true, chapters: chapters, coverURL: call.getString("coverUrl"))
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
    /// Final source check on the native owner's main actor, immediately before mutation.
    @MainActor private func acceptsExpected(_ call: CAPPluginCall) -> Bool {
        guard let expected = call.getObject("expected") else { return true } // Existing bridges remain supported.
        let actual = AvidPlaybackOwner.shared.snapshot()
        let valid = (expected["version"] as? Int) == 1 &&
            (expected["accountScope"] as? String) == (actual["accountScope"] as? String) &&
            (expected["bookId"] as? String) == (actual["bookId"] as? String) &&
            (expected["fileId"] as? String) == (actual["fileId"] as? String) &&
            (expected["manifestRevision"] as? String) == (actual["manifestRevision"] as? String)
        if !valid { call.reject("The playback source changed. Refresh the player before trying again.") }
        return valid
    }
    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.acceptsExpected(call) else { return }
            do { try AvidPlaybackOwner.shared.play(); call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func pause(_ call: CAPPluginCall) { DispatchQueue.main.async { guard self.acceptsExpected(call) else { return }; AvidPlaybackOwner.shared.pause(); call.resolve() } }
    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position"), position.isFinite else { call.reject("A finite position is required."); return }
        DispatchQueue.main.async { guard self.acceptsExpected(call) else { return }; AvidPlaybackOwner.shared.seek(position); call.resolve() }
    }
    @objc func configureRemote(_ call: CAPPluginCall) {
        guard let mode = call.getString("mode"), let seconds = call.getDouble("seconds") else { call.reject("A remote control policy is required."); return }
        Task { @MainActor in
            do { try AvidPlaybackOwner.shared.configureRemote(mode: mode, seconds: seconds, backwardSeconds: call.getDouble("backwardSeconds"), forwardSeconds: call.getDouble("forwardSeconds")); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func setRate(_ call: CAPPluginCall) {
        guard let rate = call.getDouble("rate"), rate.isFinite else { call.reject("A finite playback rate is required."); return }
        DispatchQueue.main.async { guard self.acceptsExpected(call) else { return }; AvidPlaybackOwner.shared.setRate(Float(rate)); call.resolve() }
    }
    @objc func setSleepTimer(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            AvidPlaybackOwner.shared.setSleepTimer(deadlineMilliseconds: call.getDouble("deadline"), chapterEnd: call.getDouble("chapterEnd"))
            call.resolve()
        }
    }
    @objc func snapshot(_ call: CAPPluginCall) { DispatchQueue.main.async { call.resolve(AvidPlaybackOwner.shared.snapshot()) } }
    @objc func clear(_ call: CAPPluginCall) { DispatchQueue.main.async { AvidPlaybackOwner.shared.clear(); call.resolve() } }
}

import Capacitor
import Foundation
import WebKit

@objc(AvidPlaybackPlugin)
public class AvidPlaybackPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AvidPlaybackPlugin"
    public let jsName = "AvidPlayback"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "load", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
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

    @objc func load(_ call: CAPPluginCall) {
        guard let rawURL = call.getString("url"), let url = URL(string: rawURL),
              let scope = call.getString("accountScope"), let bookId = call.getString("bookId"),
              let fileId = call.getString("fileId") else { call.reject("Missing playback identity or URL."); return }
        Task { @MainActor in
            let cookieStore = self.webView?.configuration.websiteDataStore.httpCookieStore ?? WKWebsiteDataStore.default().httpCookieStore
            let cookies = await cookieStore.allCookies()
            do {
                try AvidPlaybackOwner.shared.load(scope: scope, bookId: bookId, fileId: fileId, url: url,
                    title: call.getString("title") ?? "", author: call.getString("author") ?? "",
                    position: call.getDouble("position") ?? 0, rate: Float(call.getDouble("rate") ?? 1),
                    expiresAt: call.getString("expiresAt").flatMap { ISO8601DateFormatter().date(from: $0) }, cookies: cookies)
                call.resolve()
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func play(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do { try AvidPlaybackOwner.shared.play(); call.resolve() } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func pause(_ call: CAPPluginCall) { DispatchQueue.main.async { AvidPlaybackOwner.shared.pause(); call.resolve() } }
    @objc func seek(_ call: CAPPluginCall) {
        guard let position = call.getDouble("position"), position.isFinite else { call.reject("A finite position is required."); return }
        DispatchQueue.main.async { AvidPlaybackOwner.shared.seek(position); call.resolve() }
    }
    @objc func setRate(_ call: CAPPluginCall) {
        guard let rate = call.getDouble("rate"), rate.isFinite else { call.reject("A finite playback rate is required."); return }
        DispatchQueue.main.async { AvidPlaybackOwner.shared.setRate(Float(rate)); call.resolve() }
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

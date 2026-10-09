import AVFoundation
import CryptoKit
import Foundation
import MediaPlayer
import WebKit

/// Process-owned transport: it does not retain the Capacitor WebView or its UI.
/// Integrate into a generated Capacitor iOS target, then qualify on a physical device.
@MainActor
final class AvidPlaybackOwner: NSObject {
    static let shared = AvidPlaybackOwner()
    private let player = AVPlayer()
    private var timeObserver: Any?
    private var sleepTimer: Timer?
    private var deadline: Date?
    private var chapterEnd: Double?
    private var preferredRate: Float = 1
    private var scope = ""
    private var bookId = ""
    private var fileId = ""
    private var title = ""
    private var author = ""
    private var resumeAfterInterruption = false
    private var lastCheckpoint = Date.distantPast
    var onCheckpoint: (([String: Any]) -> Void)?

    override private init() {
        super.init()
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] _ in
            guard let self else { return }
            self.enforceSleep()
            self.publishNowPlaying()
            if Date().timeIntervalSince(self.lastCheckpoint) >= 5 { self.checkpoint() }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(interrupted(_:)), name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(routeChanged(_:)), name: AVAudioSession.routeChangeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(itemEnded(_:)), name: .AVPlayerItemDidPlayToEndTime, object: nil)
        configureRemoteCommands()
    }

    func load(scope: String, bookId: String, fileId: String, url: URL, title: String, author: String, position: Double, rate: Float, expiresAt: Date? = nil, cookies: [HTTPCookie] = []) throws {
        guard !scope.isEmpty, !bookId.isEmpty, !fileId.isEmpty else { throw PlaybackError.invalidIdentity }
        guard ["https", "http", "file"].contains(url.scheme?.lowercased() ?? "") else { throw PlaybackError.invalidURL }
        let source = AvidStoredAudioSource(accountScope: scope, bookId: bookId, fileId: fileId, url: url,
            title: title, author: author, rate: rate, expiresAt: expiresAt)
        if let expiresAt, expiresAt <= Date() { throw AvidSurfaceError.expiredSource }
        try AvidPlaybackSourceStore.save(source)
        checkpoint()
        pause()
        if AvidSharedStore.shared.isAvailable {
            if let old = AvidSharedStore.shared.activeScopeHash, old != AvidSharedStore.scopeHash(scope) {
                AvidPlaybackSourceStore.removeAccount(scopeHash: old)
                AvidSharedStore.shared.clearActiveAccount()
                AvidSystemSurfaces.removeAccount(old) { _ in }
            }
            try AvidSharedStore.shared.activate(accountScope: scope)
        }
        setSleepTimer(deadlineMilliseconds: nil, chapterEnd: nil)
        self.scope = scope
        self.bookId = bookId
        self.fileId = fileId
        self.title = title
        self.author = author
        preferredRate = min(3, max(0.5, rate))
        let item = AVPlayerItem(asset: AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: cookies]))
        item.audioTimePitchAlgorithm = .timeDomain
        player.replaceCurrentItem(with: item)
        seek(position)
        publishNowPlaying()
    }

    func play() throws {
        guard player.currentItem != nil else { throw PlaybackError.noItem }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        player.playImmediately(atRate: preferredRate)
        checkpoint()
        publishNowPlaying()
    }

    func pause() {
        player.pause()
        checkpoint()
        publishNowPlaying()
    }

    func resume(_ book: AvidRecentBook) async throws {
        guard book.scopeHash == AvidSharedStore.shared.activeScopeHash, book.kind == "audio" else { throw AvidSurfaceError.unavailableBook }
        if AvidSharedStore.scopeHash(scope) != book.scopeHash || bookId != book.bookId || fileId != book.fileId || player.currentItem == nil {
            let source = try AvidPlaybackSourceStore.source(for: book)
            let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
            try load(scope: source.accountScope, bookId: source.bookId, fileId: source.fileId, url: source.url,
                title: source.title, author: source.author, position: book.audioPosition ?? 0, rate: source.rate, expiresAt: source.expiresAt, cookies: cookies)
        }
        try play()
    }

    func pause(_ book: AvidRecentBook) throws {
        guard book.scopeHash == AvidSharedStore.shared.activeScopeHash else { throw AvidSurfaceError.unavailableBook }
        if AvidSharedStore.scopeHash(scope) == book.scopeHash && bookId == book.bookId && fileId == book.fileId { pause() }
        else {
            var stopped = book
            stopped.isPlaying = false
            stopped.updatedAt = Date()
            try AvidSharedStore.shared.save(stopped)
            AvidSystemSurfaces.refresh()
        }
    }

    func seek(_ seconds: Double) {
        guard seconds.isFinite else { return }
        let duration = player.currentItem?.duration.seconds ?? 0
        let target = max(0, duration.isFinite && duration > 0 ? min(duration, seconds) : seconds)
        player.seek(to: CMTime(seconds: target, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            guard finished else { return }
            DispatchQueue.main.async { self?.enforceSleep(); self?.checkpoint(); self?.publishNowPlaying() }
        }
    }

    func setRate(_ rate: Float) {
        guard rate.isFinite else { return }
        preferredRate = min(3, max(0.5, rate))
        if player.rate > 0 { player.rate = preferredRate }
        publishNowPlaying()
    }

    func setSleepTimer(deadlineMilliseconds: Double?, chapterEnd: Double?) {
        sleepTimer?.invalidate()
        sleepTimer = nil
        deadline = deadlineMilliseconds.flatMap { $0.isFinite ? Date(timeIntervalSince1970: $0 / 1000) : nil }
        self.chapterEnd = chapterEnd.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        if let deadline {
            sleepTimer = Timer.scheduledTimer(withTimeInterval: max(0.01, deadline.timeIntervalSinceNow), repeats: false) { [weak self] _ in self?.finishSleep() }
        }
        enforceSleep()
    }

    func snapshot() -> [String: Any] {
        let position = player.currentTime().seconds
        let duration = player.currentItem?.duration.seconds ?? 0
        return ["accountScope": scope, "bookId": bookId, "fileId": fileId,
                "position": position.isFinite ? max(0, position) : 0,
                "duration": duration.isFinite ? max(0, duration) : 0,
                "rate": preferredRate, "playing": player.timeControlStatus == .playing,
                "status": player.currentItem?.status == .failed ? "failed" : player.timeControlStatus == .waitingToPlayAtSpecifiedRate ? "buffering" : player.timeControlStatus == .playing ? "playing" : player.currentItem == nil ? "stopped" : "paused",
                "error": player.currentItem?.error?.localizedDescription ?? "",
                "ended": duration.isFinite && duration > 0 && position >= duration,
                "updatedAt": ISO8601DateFormatter().string(from: Date())]
    }

    func clear() {
        pause()
        setSleepTimer(deadlineMilliseconds: nil, chapterEnd: nil)
        player.replaceCurrentItem(with: nil)
        scope = ""; bookId = ""; fileId = ""; title = ""; author = ""
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func checkpoint() {
        guard !scope.isEmpty, !bookId.isEmpty else { return }
        let value = snapshot()
        let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        // Native checkpoint remains available while the WebView is suspended.
        // A server-sync journal is a separate integration; this is not a sync acknowledgement.
        UserDefaults.standard.set(value, forKey: "avid.playback.\(hash)")
        lastCheckpoint = Date()
        if AvidSharedStore.shared.activeScopeHash == hash {
            let duration = value["duration"] as? Double ?? 0
            let position = value["position"] as? Double ?? 0
            let book = AvidRecentBook(scopeHash: hash, bookId: bookId, fileId: fileId, title: title, author: author,
                kind: "audio", progress: duration > 0 ? min(1, position / duration) : 0,
                audioPosition: position, audioDuration: duration, isPlaying: player.timeControlStatus == .playing, updatedAt: Date())
            try? AvidSharedStore.shared.save(book)
            AvidSystemSurfaces.refresh()
        }
        onCheckpoint?(value)
    }

    private func enforceSleep() {
        if let deadline, Date() >= deadline { finishSleep(); return }
        if let chapterEnd, player.currentTime().seconds >= chapterEnd { finishSleep() }
    }

    private func finishSleep() {
        let target = chapterEnd
        setSleepTimer(deadlineMilliseconds: nil, chapterEnd: nil)
        pause()
        if let target { seek(target) }
    }

    private func publishNowPlaying() {
        guard !bookId.isEmpty else { return }
        let state = snapshot()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: author,
            MPMediaItemPropertyAlbumTitle: "Avid",
            MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: state["position"] ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: preferredRate]
    }

    private func configureRemoteCommands() {
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { [weak self] _ in
            do { try self?.play(); return .success } catch { return .commandFailed }
        }
        commands.pauseCommand.addTarget { [weak self] _ in self?.pause(); return .success }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.player.rate > 0 { self.pause() } else { do { try self.play() } catch { return .commandFailed } }
            return .success
        }
        commands.skipForwardCommand.preferredIntervals = [30]
        commands.skipBackwardCommand.preferredIntervals = [30]
        commands.skipForwardCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self.seek(self.player.currentTime().seconds + event.interval); return .success
        }
        commands.skipBackwardCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self.seek(self.player.currentTime().seconds - event.interval); return .success
        }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(event.positionTime); return .success
        }
    }

    @objc private func interrupted(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            resumeAfterInterruption = player.rate > 0
            pause()
        } else {
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            if resumeAfterInterruption && options.contains(.shouldResume) { try? play() }
            resumeAfterInterruption = false
        }
    }

    @objc private func routeChanged(_ notification: Notification) {
        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { pause() }
    }

    @objc private func itemEnded(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem, item === player.currentItem else { return }
        pause()
    }

    enum PlaybackError: LocalizedError {
        case invalidIdentity, invalidURL, noItem
        var errorDescription: String? {
            switch self {
            case .invalidIdentity: return "A server/account scope and stable book/file IDs are required."
            case .invalidURL: return "The audio URL has an unsupported scheme."
            case .noItem: return "Load an audiobook before starting playback."
            }
        }
    }
}

// WKHTTPCookieStore is the WebView's authenticated cookie owner; no cookie copy is persisted.
extension WKHTTPCookieStore {
    func allCookies() async -> [HTTPCookie] {
        await withCheckedContinuation { continuation in
            getAllCookies { continuation.resume(returning: $0) }
        }
    }
}

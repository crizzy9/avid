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
    private let player = AVQueuePlayer()
    private var tracks: [AvidAudioTrack] = []
    private var itemIndices: [ObjectIdentifier: Int] = [:]
    private var activeIndex = 0
    private var finalPosition: Double?
    private var manifestRevision: String?
    private var assetCookies: [HTTPCookie] = []
    private var currentItemObservation: NSKeyValueObservation?
    private var seekGeneration: UInt = 0
    private var desiredPlaying = false
    private var pendingSeek: (generation: UInt, index: Int, position: Double)?
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
        currentItemObservation = player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if let item = self.player.currentItem, let index = self.itemIndices[ObjectIdentifier(item)] { self.activeIndex = index }
                self.enforceSleep(); self.checkpoint(); self.publishNowPlaying()
            }
        }
        configureRemoteCommands()
    }

    func load(scope: String, bookId: String, fileId: String, url: URL, title: String, author: String, position: Double, rate: Float, expiresAt: Date? = nil, cookies: [HTTPCookie] = [], tracks requestedTracks: [AvidAudioTrack]? = nil, manifestRevision: String? = nil) throws {
        guard !scope.isEmpty, !bookId.isEmpty, !fileId.isEmpty else { throw PlaybackError.invalidIdentity }
        let newTracks = requestedTracks ?? [AvidAudioTrack(id: fileId, url: url, duration: nil)]
        guard !newTracks.isEmpty, Set(newTracks.map(\.id)).count == newTracks.count,
              newTracks.enumerated().allSatisfy({ index, track in
                  !track.id.isEmpty && ["https", "http", "file"].contains(track.url.scheme?.lowercased() ?? "") &&
                  (index == newTracks.count - 1 || track.duration != nil) &&
                  (track.duration == nil || (track.duration!.isFinite && track.duration! > 0))
              }) else { throw PlaybackError.invalidTimeline }
        let source = AvidStoredAudioSource(accountScope: scope, bookId: bookId, fileId: fileId, url: url,
            tracks: newTracks, manifestRevision: manifestRevision, title: title, author: author, rate: rate, expiresAt: expiresAt)
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
        self.tracks = newTracks
        self.manifestRevision = manifestRevision
        assetCookies = cookies
        finalPosition = nil
        player.removeAllItems()
        itemIndices.removeAll()
        pendingSeek = nil
        seek(position)
        publishNowPlaying()
    }

    func play() throws {
        guard player.currentItem != nil else { throw PlaybackError.noItem }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        desiredPlaying = true
        player.playImmediately(atRate: preferredRate)
        checkpoint()
        publishNowPlaying()
    }

    func pause() {
        desiredPlaying = false
        player.pause()
        checkpoint()
        publishNowPlaying()
    }

    func resume(_ book: AvidRecentBook) async throws {
        guard book.scopeHash == AvidSharedStore.shared.activeScopeHash, book.kind == "audio" else { throw AvidSurfaceError.unavailableBook }
        if AvidSharedStore.scopeHash(scope) != book.scopeHash || bookId != book.bookId || fileId != book.fileId || player.currentItem == nil {
            let source = try AvidPlaybackSourceStore.source(for: book)
            let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
            guard AvidSharedStore.shared.activeScopeHash == source.scopeHash else { throw AvidSurfaceError.unavailableBook }
            try load(scope: source.accountScope, bookId: source.bookId, fileId: source.fileId, url: source.url,
                title: source.title, author: source.author, position: book.audioPosition ?? 0, rate: source.rate, expiresAt: source.expiresAt, cookies: cookies, tracks: source.tracks, manifestRevision: source.manifestRevision)
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

    private func trackStart(_ index: Int) -> Double { tracks.prefix(index).reduce(0) { $0 + ($1.duration ?? 0) } }
    private var currentTrackIndex: Int {
        if let pendingSeek { return pendingSeek.index }
        if let item = player.currentItem, let index = itemIndices[ObjectIdentifier(item)] { return index }
        return activeIndex
    }
    private var globalPosition: Double {
        if let pendingSeek { return pendingSeek.position }
        if let finalPosition { return finalPosition }
        let time = player.currentTime().seconds
        return trackStart(currentTrackIndex) + (time.isFinite ? max(0, time) : 0)
    }
    private var totalDuration: Double {
        guard !tracks.isEmpty else { return 0 }
        if tracks.allSatisfy({ $0.duration != nil }) { return tracks.reduce(0) { $0 + $1.duration! } }
        if currentTrackIndex == tracks.count - 1, let duration = player.currentItem?.duration.seconds, duration.isFinite {
            return trackStart(currentTrackIndex) + max(0, duration)
        }
        return finalPosition ?? 0
    }
    private func rebuildQueue(from index: Int) {
        player.removeAllItems()
        itemIndices.removeAll()
        activeIndex = index
        for trackIndex in index..<tracks.count {
            let track = tracks[trackIndex]
            // Foundation has the latest native HTTP cookies even while its WK synchronization is pending.
            var cookies = assetCookies
            for cookie in HTTPCookieStorage.shared.cookies(for: track.url) ?? [] {
                cookies.removeAll { $0.name == cookie.name && $0.domain == cookie.domain && $0.path == cookie.path }
                cookies.append(cookie)
            }
            let item = AVPlayerItem(asset: AVURLAsset(url: track.url, options: [AVURLAssetHTTPCookiesKey: cookies]))
            item.audioTimePitchAlgorithm = .timeDomain
            itemIndices[ObjectIdentifier(item)] = trackIndex
            player.insert(item, after: nil)
        }
    }
    func seek(_ seconds: Double) {
        guard seconds.isFinite, !tracks.isEmpty else { return }
        seekGeneration &+= 1
        let generation = seekGeneration
        var remaining = max(0, seconds)
        var index = 0
        while index < tracks.count - 1, let duration = tracks[index].duration, remaining >= duration {
            remaining -= duration; index += 1
        }
        let target = min(remaining, tracks[index].duration ?? .infinity)
        let needsQueue = index != currentTrackIndex || player.currentItem == nil
        pendingSeek = (generation, index, trackStart(index) + target)
        finalPosition = nil
        if needsQueue { rebuildQueue(from: index) }
        player.seek(to: CMTime(seconds: target, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.seekGeneration == generation else { return }
                guard finished else {
                    // Preserve the requested anchor while an asset fails; never save a transient zero.
                    self.checkpoint(); self.publishNowPlaying(); return
                }
                self.pendingSeek = nil
                if self.desiredPlaying { self.player.playImmediately(atRate: self.preferredRate) }
                self.enforceSleep(); self.checkpoint(); self.publishNowPlaying()
            }
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
        let position = globalPosition
        let duration = totalDuration
        var value: [String: Any] = ["accountScope": scope, "bookId": bookId, "fileId": fileId,
                "position": position.isFinite ? max(0, position) : 0,
                "duration": duration.isFinite ? max(0, duration) : 0,
                "rate": preferredRate, "playing": pendingSeek == nil && player.timeControlStatus == .playing,
                "status": player.currentItem?.status == .failed ? "failed" : pendingSeek != nil ? "loading" : player.timeControlStatus == .waitingToPlayAtSpecifiedRate ? "buffering" : player.timeControlStatus == .playing ? "playing" : player.currentItem == nil ? "stopped" : "paused",
                "error": player.currentItem?.error?.localizedDescription ?? "",
                "ended": duration.isFinite && duration > 0 && position >= duration,
                "updatedAt": ISO8601DateFormatter().string(from: Date())]
        if tracks.indices.contains(currentTrackIndex) {
            value["trackId"] = tracks[currentTrackIndex].id
            value["trackIndex"] = currentTrackIndex
            value["trackTime"] = max(0, position - trackStart(currentTrackIndex))
        }
        if let manifestRevision { value["manifestRevision"] = manifestRevision }
        return value
    }

    func clear() {
        seekGeneration &+= 1
        pendingSeek = nil
        pause()
        setSleepTimer(deadlineMilliseconds: nil, chapterEnd: nil)
        player.removeAllItems()
        tracks = []; itemIndices = [:]; activeIndex = 0; finalPosition = nil; manifestRevision = nil; assetCookies = []
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
        if let chapterEnd, globalPosition >= chapterEnd { finishSleep() }
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
            self.seek(self.globalPosition + event.interval); return .success
        }
        commands.skipBackwardCommand.addTarget { [weak self] event in
            guard let self, let event = event as? MPSkipIntervalCommandEvent else { return .commandFailed }
            self.seek(self.globalPosition - event.interval); return .success
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
        guard let item = notification.object as? AVPlayerItem, let index = itemIndices[ObjectIdentifier(item)] else { return }
        if index == tracks.count - 1 {
            let duration = item.duration.seconds
            finalPosition = trackStart(index) + (duration.isFinite ? duration : tracks[index].duration ?? 0)
            activeIndex = index
            pause()
        } else {
            // AVQueuePlayer advances autonomously; no WebView timer performs track transitions.
            activeIndex = index + 1
            enforceSleep(); checkpoint()
        }
    }

    enum PlaybackError: LocalizedError {
        case invalidIdentity, invalidURL, invalidTimeline, noItem
        var errorDescription: String? {
            switch self {
            case .invalidIdentity: return "A server/account scope and stable book/file IDs are required."
            case .invalidURL: return "The audio URL has an unsupported scheme."
            case .invalidTimeline: return "Audio tracks require unique IDs, supported URLs and positive durations for every nonfinal track."
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

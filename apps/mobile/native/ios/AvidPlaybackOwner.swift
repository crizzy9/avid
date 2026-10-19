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
    private var chapters: [AvidAudioChapter] = []
    private var artwork: MPMediaItemArtwork?
    private var artworkTask: Task<Void, Never>?
    private var playbackEvents: [[String: Any]] = []
    private var playbackEventSequence = 0
    private var remoteMode = UserDefaults.standard.string(forKey: "avid.remote.mode") == "chapter" ? "chapter" : "time"
    private var remoteBackwardSeconds = AvidPlaybackOwner.remoteInterval(key: "avid.remote.backwardSeconds", fallback: 15)
    private var remoteForwardSeconds = AvidPlaybackOwner.remoteInterval(key: "avid.remote.forwardSeconds", fallback: 30)
    private static func remoteInterval(key: String, fallback: Double) -> Double {
        let defaults = UserDefaults.standard
        let value = defaults.object(forKey: key) != nil ? defaults.double(forKey: key) : defaults.double(forKey: "avid.remote.seconds")
        return value.isFinite && value >= 1 && value <= 300 ? value.rounded() : fallback
    }
    private var itemIndices: [ObjectIdentifier: Int] = [:]
    private var activeIndex = 0
    private var finalPosition: Double?
    private var manifestRevision: String?
    private var sourceReadOnly = true
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
    private var sourceGeneration = UUID()
    private var authenticationTask: Task<Void, Never>?
    private var authenticationError: String?
    private var authenticationTimer: Timer?
    private var lastAuthenticationAttempt = Date.distantPast
    private var credentialGeneration: String?
    private var credentialObserver: NSObjectProtocol?
    private var itemErrorObserver: NSObjectProtocol?
    private var authenticationRecoveryNeeded = false
    private var retriedUnauthorized = false
    var onCheckpoint: (([String: Any]) -> Void)?

    override private init() {
        super.init()
        player.automaticallyWaitsToMinimizeStalling = true
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] _ in
            guard let self else { return }
            if self.player.timeControlStatus == .playing { self.retriedUnauthorized = false }
            try? AvidPlaybackJournal.shared.sample(self.snapshot())
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
        let renewal = Timer(timeInterval: 30, repeats: true) { [weak self] _ in
            guard let self, self.desiredPlaying else { return }
            do { _ = try self.renewCredentialsIfNeeded() }
            catch { self.authenticationError = error.localizedDescription; self.checkpoint() }
        }
        RunLoop.main.add(renewal, forMode: .common)
        authenticationTimer = renewal
        credentialObserver = NotificationCenter.default.addObserver(forName: AvidAuthCoordinator.changed, object: nil, queue: .main) { [weak self] notification in
            let account = notification.userInfo?["accountScope"] as? String
            let generation = notification.userInfo?["generation"] as? String
            Task { @MainActor in
                guard let self, let generation, account == self.scope, generation != self.credentialGeneration,
                      let current = try? AvidAuthCoordinator.shared.bound(self.scope),
                      self.tracks.contains(where: { AvidAuthCoordinator.protects(scope: self.scope, url: $0.url) }) else { return }
                self.credentialGeneration = current.generation
                // A refresh initiated here will rebuild once its shared task returns.
                if self.authenticationTask != nil { return }
                self.authenticationError = nil; self.authenticationRecoveryNeeded = false; self.assetCookies = []
                self.seek(self.globalPosition, forceRebuild: true)
                self.checkpoint()
            }
        }
        itemErrorObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.newErrorLogEntryNotification, object: nil, queue: .main) { [weak self] notification in
            guard let item = notification.object as? AVPlayerItem else { return }
            Task { @MainActor in
                guard let self, item === self.player.currentItem,
                      self.tracks.contains(where: { AvidAuthCoordinator.protects(scope: self.scope, url: $0.url) }),
                      item.errorLog()?.events.last?.errorStatusCode == 401 else { return }
                self.authenticationRecoveryNeeded = true
                guard self.desiredPlaying else { return }
                guard !self.retriedUnauthorized else {
                    self.authenticationError = AvidAuthCoordinator.Failure.unauthorized.localizedDescription
                    self.lastAuthenticationAttempt = Date()
                    self.desiredPlaying = false; self.player.pause(); self.checkpoint()
                    return
                }
                self.retriedUnauthorized = true
                do { _ = try self.renewCredentialsIfNeeded() }
                catch { self.authenticationError = error.localizedDescription; self.checkpoint() }
            }
        }
    }

    func load(scope: String, bookId: String, fileId: String, url: URL, title: String, author: String, position: Double, rate: Float, expiresAt: Date? = nil, cookies: [HTTPCookie] = [], tracks requestedTracks: [AvidAudioTrack]? = nil, manifestRevision: String? = nil, readOnly: Bool = true, chapters requestedChapters: [AvidAudioChapter] = [], coverURL: String? = nil) throws {
        guard !scope.isEmpty, !bookId.isEmpty, !fileId.isEmpty else { throw PlaybackError.invalidIdentity }
        let newTracks = requestedTracks ?? [AvidAudioTrack(id: fileId, url: url, duration: nil)]
        guard !newTracks.isEmpty, Set(newTracks.map(\.id)).count == newTracks.count,
              newTracks.enumerated().allSatisfy({ index, track in
                  !track.id.isEmpty && ["https", "http", "file"].contains(track.url.scheme?.lowercased() ?? "") &&
                  (index == newTracks.count - 1 || track.duration != nil) &&
                  (track.duration == nil || (track.duration!.isFinite && track.duration! > 0))
              }) else { throw PlaybackError.invalidTimeline }
        guard AvidAudioChapter.validate(requestedChapters) else { throw PlaybackError.invalidTimeline }
        guard newTracks.allSatisfy({ !$0.url.isFileURL || AvidMediaStore.shared.owns($0.url, scope: scope, book: bookId, file: fileId, track: $0.id) }) else { throw AvidMediaStore.Failure.missing }
        let source = AvidStoredAudioSource(accountScope: scope, bookId: bookId, fileId: fileId, url: url,
            tracks: newTracks, chapters: requestedChapters, manifestRevision: manifestRevision, readOnly: readOnly, title: title, author: author, rate: rate, expiresAt: expiresAt)
        if let expiresAt, expiresAt <= Date() { throw AvidSurfaceError.expiredSource }
        try AvidPlaybackSourceStore.save(source)
        checkpoint()
        pause()
        authenticationTask?.cancel(); authenticationTask = nil
        sourceGeneration = UUID(); authenticationError = nil
        playbackEvents = []; playbackEventSequence = 0
        authenticationRecoveryNeeded = false; retriedUnauthorized = false
        credentialGeneration = try? AvidSessionStore.read()["generation"] as? String
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
        self.chapters = requestedChapters
        self.manifestRevision = manifestRevision
        sourceReadOnly = readOnly
        assetCookies = cookies
        finalPosition = nil
        player.removeAllItems()
        itemIndices.removeAll()
        pendingSeek = nil
        seek(position, reason: "source-load")
        recordPlaybackEvent(kind: "load", reason: "source-load", from: position)
        updateArtwork(coverURL)
        publishNowPlaying()
    }

    func play(reason: String = "native-observation") throws {
        guard player.currentItem != nil else { throw PlaybackError.noItem }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
        if !desiredPlaying { retriedUnauthorized = false }
        desiredPlaying = true
        do { if try renewCredentialsIfNeeded() { checkpoint(); return } }
        catch { desiredPlaying = false; authenticationError = error.localizedDescription; checkpoint(); throw error }
        player.playImmediately(atRate: preferredRate)
        recordPlaybackEvent(kind: "play", reason: reason, from: globalPosition)
        checkpoint()
        publishNowPlaying()
    }

    func pause(reason: String = "native-observation") {
        try? AvidPlaybackJournal.shared.sample(snapshot())
        try? AvidPlaybackJournal.shared.flush()
        desiredPlaying = false
        player.pause()
        recordPlaybackEvent(kind: "pause", reason: reason, from: globalPosition)
        checkpoint()
        publishNowPlaying()
    }

    func resume(_ book: AvidRecentBook) async throws {
        guard book.scopeHash == AvidSharedStore.shared.activeScopeHash, book.kind == "audio" else { throw AvidSurfaceError.unavailableBook }
        let prepared = try AvidPlaybackSourceStore.source(for: book)
        if AvidAuthCoordinator.protects(scope: prepared.accountScope, url: prepared.url) {
            _ = try await AvidAuthCoordinator.shared.refresh(scope: prepared.accountScope)
            guard AvidSharedStore.shared.activeScopeHash == prepared.scopeHash else { throw AvidSurfaceError.unavailableBook }
        }
        if AvidSharedStore.scopeHash(scope) != book.scopeHash || bookId != book.bookId || fileId != book.fileId || player.currentItem == nil {
            let source = prepared
            let cookies = await WKWebsiteDataStore.default().httpCookieStore.allCookies()
            guard AvidSharedStore.shared.activeScopeHash == source.scopeHash else { throw AvidSurfaceError.unavailableBook }
            try load(scope: source.accountScope, bookId: source.bookId, fileId: source.fileId, url: source.url,
                title: source.title, author: source.author, position: book.audioPosition ?? 0, rate: source.rate, expiresAt: source.expiresAt, cookies: cookies, tracks: source.tracks, manifestRevision: source.manifestRevision, readOnly: source.readOnly ?? true, chapters: source.chapters ?? [])
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
    func seek(_ seconds: Double, forceRebuild: Bool = false, reason: String = "native-observation") {
        guard seconds.isFinite, !tracks.isEmpty else { return }
        let previousPosition = reason == "source-load" ? max(0, seconds) : globalPosition
        try? AvidPlaybackJournal.shared.flush()
        seekGeneration &+= 1
        let generation = seekGeneration
        var remaining = max(0, seconds)
        var index = 0
        while index < tracks.count - 1, let duration = tracks[index].duration, remaining >= duration {
            remaining -= duration; index += 1
        }
        let target = min(remaining, tracks[index].duration ?? .infinity)
        let needsQueue = forceRebuild || index != currentTrackIndex || player.currentItem == nil
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
                self.recordPlaybackEvent(kind: "seek", reason: reason, from: previousPosition)
                if self.desiredPlaying && self.authenticationTask == nil { self.player.playImmediately(atRate: self.preferredRate) }
                self.enforceSleep(); self.checkpoint(); self.publishNowPlaying()
            }
        }
    }

    /// Foreground and background owners share the same generation-checked refresh transaction.
    /// Cookies captured by queued AVURLAssets are rebuilt only after native credential commit.
    private func renewCredentialsIfNeeded() throws -> Bool {
        guard tracks.contains(where: { AvidAuthCoordinator.protects(scope: scope, url: $0.url) }) else { return false }
        if authenticationTask != nil { return true }
        if !authenticationRecoveryNeeded {
            guard try AvidAuthCoordinator.shared.needsRefresh(scope: scope) else { return false }
        }
        // Failed background requests are bounded; an explicit play can still report the last failure.
        if Date().timeIntervalSince(lastAuthenticationAttempt) < 20, let authenticationError {
            throw NSError(domain: "app.avid.authentication", code: 1, userInfo: [NSLocalizedDescriptionKey: authenticationError])
        }
        lastAuthenticationAttempt = Date()
        let generation = sourceGeneration, expectedScope = scope, force = authenticationRecoveryNeeded
        authenticationTask = Task { @MainActor [weak self] in
            do {
                let record = try await AvidAuthCoordinator.shared.refresh(scope: expectedScope, force: force)
                guard let self, !Task.isCancelled, self.sourceGeneration == generation, self.scope == expectedScope else { return }
                self.authenticationTask = nil; self.authenticationError = nil
                self.authenticationRecoveryNeeded = false
                self.credentialGeneration = record["generation"] as? String
                let position = self.globalPosition
                self.assetCookies = []
                self.seek(position, forceRebuild: true)
                self.checkpoint()
            } catch {
                guard let self, !Task.isCancelled, self.sourceGeneration == generation else { return }
                self.authenticationTask = nil; self.authenticationError = error.localizedDescription
                if self.player.timeControlStatus != .playing { self.desiredPlaying = false; self.player.pause() }
                self.checkpoint()
            }
        }
        return true
    }

    func setRate(_ rate: Float) {
        guard rate.isFinite else { return }
        preferredRate = min(3, max(0.5, rate))
        if player.rate > 0 { player.rate = preferredRate }
        recordPlaybackEvent(kind: "rate", reason: "rate-change", from: globalPosition)
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

    private func recordPlaybackEvent(kind: String, reason: String, from: Double) {
        guard !scope.isEmpty, !bookId.isEmpty, from.isFinite, globalPosition.isFinite else { return }
        playbackEventSequence += 1
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        playbackEvents.append(["sequence": playbackEventSequence, "kind": kind, "reason": reason,
            "observedAt": formatter.string(from: Date()), "fromSourceSeconds": max(0, from), "toSourceSeconds": max(0, globalPosition),
            "rate": preferredRate, "status": player.currentItem?.status == .failed ? "failed" : player.timeControlStatus == .playing ? "playing" : pendingSeek != nil ? "loading" : "paused"])
        if playbackEvents.count > 64 { playbackEvents.removeFirst(playbackEvents.count - 64) }
    }

    func snapshot() -> [String: Any] {
        let position = globalPosition
        let duration = totalDuration
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var value: [String: Any] = ["accountScope": scope, "bookId": bookId, "fileId": fileId,
                "position": position.isFinite ? max(0, position) : 0,
                "duration": duration.isFinite ? max(0, duration) : 0,
                "rate": preferredRate, "playing": pendingSeek == nil && player.timeControlStatus == .playing,
                "status": player.currentItem?.status == .failed ? "failed" : pendingSeek != nil ? "loading" : player.timeControlStatus == .waitingToPlayAtSpecifiedRate ? "buffering" : player.timeControlStatus == .playing ? "playing" : authenticationTask != nil ? "loading" : player.currentItem == nil ? "stopped" : "paused",
                "error": player.currentItem?.error?.localizedDescription ?? authenticationError ?? "",
                "recoveryError": AvidPlaybackJournal.shared.recoveryError ?? "",
                "ended": duration.isFinite && duration > 0 && position >= duration,
                "updatedAt": formatter.string(from: Date())]
        if tracks.indices.contains(currentTrackIndex) {
            value["trackId"] = tracks[currentTrackIndex].id
            value["trackIndex"] = currentTrackIndex
            value["trackTime"] = max(0, position - trackStart(currentTrackIndex))
        }
        let chapter = chapters.firstIndex { position >= $0.start && position < $0.start + $0.duration }
        value["chapterIndex"] = chapter ?? -1
        if let chapter { value["chapterTitle"] = chapters[chapter].title }
        if let manifestRevision { value["manifestRevision"] = manifestRevision }
        value["trackIds"] = tracks.map(\.id)
        value["nativeEvents"] = ["version": 1, "ownerId": sourceGeneration.uuidString, "accountScope": scope, "bookId": bookId,
            "fileId": fileId, "manifestRevision": manifestRevision as Any? ?? NSNull(), "events": playbackEvents] as [String: Any]
        value["readOnly"] = sourceReadOnly || AvidSessionStore.readOnly(scope: scope)
        value["sleepUntil"] = deadline.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull()
        value["sleepAtChapterEnd"] = chapterEnd as Any? ?? NSNull()
        return value
    }

    func clear() {
        authenticationTask?.cancel(); authenticationTask = nil
        sourceGeneration = UUID(); authenticationError = nil
        playbackEvents = []; playbackEventSequence = 0
        authenticationRecoveryNeeded = false; retriedUnauthorized = false
        credentialGeneration = nil
        seekGeneration &+= 1
        pendingSeek = nil
        pause()
        setSleepTimer(deadlineMilliseconds: nil, chapterEnd: nil)
        player.removeAllItems()
        artworkTask?.cancel(); artworkTask = nil; artwork = nil; chapters = []
        tracks = []; itemIndices = [:]; activeIndex = 0; finalPosition = nil; manifestRevision = nil; assetCookies = []
        scope = ""; bookId = ""; fileId = ""; title = ""; author = ""
        playbackEvents = []; playbackEventSequence = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func checkpoint() {
        guard !scope.isEmpty, !bookId.isEmpty else { return }
        let value = snapshot()
        try? AvidPlaybackJournal.shared.sample(value)
        try? AvidPlaybackJournal.shared.recordProgress(value)
        let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        // Native checkpoint remains available while the WebView is suspended.
        // SQLite events are replayed into the repository outbox on JS return; this record is not a server acknowledgement.
        var recovery = value; recovery.removeValue(forKey: "nativeEvents")
        UserDefaults.standard.set(recovery, forKey: "avid.playback.\(hash)")
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
        // The insertion above can change durable health; notify with the resulting state.
        onCheckpoint?(snapshot())
    }

    private func enforceSleep() {
        if let deadline, Date() >= deadline { finishSleep(); return }
        if let chapterEnd, globalPosition >= chapterEnd { finishSleep() }
    }

    private func finishSleep() {
        let target = chapterEnd
        setSleepTimer(deadlineMilliseconds: nil, chapterEnd: nil)
        pause(reason: "sleep")
        if let target { seek(target, reason: "sleep") }
    }

    private func updateArtwork(_ raw: String?) {
        artworkTask?.cancel(); artwork = nil
        let generation = sourceGeneration, expectedScope = scope, expectedBook = bookId, expectedFile = fileId
        artworkTask = Task { @MainActor [weak self] in
            let image = await AvidArtwork.load(raw: raw, scope: expectedScope, book: expectedBook, file: expectedFile)
            guard !Task.isCancelled, let self, self.sourceGeneration == generation, let image else { return }
            self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            self.publishNowPlaying()
        }
    }

    func configureRemote(mode: String, seconds: Double, backwardSeconds: Double? = nil, forwardSeconds: Double? = nil) throws {
        let backward = backwardSeconds ?? seconds
        let forward = forwardSeconds ?? seconds
        guard ["time", "chapter"].contains(mode), [seconds, backward, forward].allSatisfy({ $0.isFinite && $0 >= 1 && $0 <= 300 }) else { throw PlaybackError.invalidTimeline }
        remoteMode = mode; remoteBackwardSeconds = backward.rounded(); remoteForwardSeconds = forward.rounded()
        UserDefaults.standard.set(mode, forKey: "avid.remote.mode")
        UserDefaults.standard.set(seconds.rounded(), forKey: "avid.remote.seconds")
        UserDefaults.standard.set(remoteBackwardSeconds, forKey: "avid.remote.backwardSeconds")
        UserDefaults.standard.set(remoteForwardSeconds, forKey: "avid.remote.forwardSeconds")
        let commands = MPRemoteCommandCenter.shared()
        commands.skipForwardCommand.preferredIntervals = [NSNumber(value: remoteForwardSeconds)]
        commands.skipBackwardCommand.preferredIntervals = [NSNumber(value: remoteBackwardSeconds)]
    }

    private func remoteSkip(_ direction: Int) {
        let position = globalPosition
        if remoteMode == "chapter", !chapters.isEmpty {
            let index = chapters.lastIndex { $0.start <= position } ?? -1
            if direction < 0 {
                if index >= 0, position - chapters[index].start > 3 { seek(chapters[index].start, reason: "remote") }
                else { seek(chapters[max(0, index - 1)].start, reason: "remote") }
                return
            }
            if index + 1 < chapters.count { seek(chapters[index + 1].start, reason: "remote"); return }
        }
        seek(max(0, position + Double(direction) * (direction < 0 ? remoteBackwardSeconds : remoteForwardSeconds)), reason: "remote")
    }

    private func publishNowPlaying() {
        guard !bookId.isEmpty else { return }
        let state = snapshot()
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: author,
            MPMediaItemPropertyAlbumTitle: title,
            MPMediaItemPropertyPlaybackDuration: state["duration"] ?? 0,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: state["position"] ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: preferredRate]
        if let chapter = state["chapterIndex"] as? Int, chapters.indices.contains(chapter) {
            info[MPNowPlayingInfoPropertyChapterNumber] = chapter + 1
            info[MPNowPlayingInfoPropertyChapterCount] = chapters.count
            info[MPMediaItemPropertyTitle] = chapters[chapter].title
        }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func configureRemoteCommands() {
        let commands = MPRemoteCommandCenter.shared()
        commands.playCommand.addTarget { [weak self] _ in
            do { try self?.play(reason: "remote"); return .success } catch { return .commandFailed }
        }
        commands.pauseCommand.addTarget { [weak self] _ in self?.pause(reason: "remote"); return .success }
        commands.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.player.rate > 0 { self.pause(reason: "remote") } else { do { try self.play(reason: "remote") } catch { return .commandFailed } }
            return .success
        }
        commands.skipForwardCommand.preferredIntervals = [NSNumber(value: remoteForwardSeconds)]
        commands.skipBackwardCommand.preferredIntervals = [NSNumber(value: remoteBackwardSeconds)]
        commands.skipForwardCommand.addTarget { [weak self] event in
            guard let self, event is MPSkipIntervalCommandEvent else { return .commandFailed }
            self.remoteSkip(1); return .success
        }
        commands.skipBackwardCommand.addTarget { [weak self] event in
            guard let self, event is MPSkipIntervalCommandEvent else { return .commandFailed }
            self.remoteSkip(-1); return .success
        }
        commands.nextTrackCommand.addTarget { [weak self] _ in self?.remoteSkip(1); return .success }
        commands.previousTrackCommand.addTarget { [weak self] _ in self?.remoteSkip(-1); return .success }
        commands.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self?.seek(event.positionTime, reason: "remote"); return .success
        }
    }

    @objc private func interrupted(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            resumeAfterInterruption = player.rate > 0
            pause(reason: "interruption")
        } else {
            let rawOptions = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let options = AVAudioSession.InterruptionOptions(rawValue: rawOptions)
            if resumeAfterInterruption && options.contains(.shouldResume) { try? play(reason: "interruption") }
            resumeAfterInterruption = false
        }
    }

    @objc private func routeChanged(_ notification: Notification) {
        let reason = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
        if reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue { pause(reason: "interruption") }
    }

    @objc private func itemEnded(_ notification: Notification) {
        guard let item = notification.object as? AVPlayerItem, let index = itemIndices[ObjectIdentifier(item)] else { return }
        if index == tracks.count - 1 {
            let duration = item.duration.seconds
            finalPosition = trackStart(index) + (tracks[index].duration ?? (duration.isFinite ? duration : 0))
            activeIndex = index
            pause(reason: "completion")
        } else {
            // AVQueuePlayer advances autonomously; no WebView timer performs track transitions.
            activeIndex = index + 1
            recordPlaybackEvent(kind: "status", reason: "track-transition", from: trackStart(index + 1))
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

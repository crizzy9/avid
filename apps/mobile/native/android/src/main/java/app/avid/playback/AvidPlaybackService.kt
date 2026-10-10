package app.avid.playback

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.PlaybackException
import androidx.media3.common.MediaItem
import androidx.media3.common.Timeline
import androidx.media3.datasource.HttpDataSource
import androidx.media3.common.ForwardingPlayer
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import java.security.MessageDigest
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Playback and checkpoints belong to the service, not to the WebView activity. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class AvidPlaybackService : MediaLibraryService() {
    private lateinit var player: ExoPlayer
    private var session: MediaLibrarySession? = null
    private val handler = Handler(Looper.getMainLooper())
    private var sleepDeadline: Long? = null
    private var chapterEndMs: Long? = null
    private var lastCheckpoint = 0L
    private var stopCatalogObserver: (() -> Unit)? = null
    private var stopAuthObserver: (() -> Unit)? = null
    @Volatile private var sourceScope = ""
    @Volatile private var sourceEpoch = 0L
    private var authError = ""
    private var authBusy = false
    private var lastAuthCheck = 0L
    private var lastAuthFailure = 0L
    private var needsPrepareAfterAuth = false
    private var retriedUnauthorized = false
    private var destroyed = false

    private val ticker = object : Runnable {
        override fun run() {
            snapshot()?.let { value -> runCatching { AvidPlaybackJournal.sample(value) } }
            val now = System.currentTimeMillis()
            if ((sleepDeadline != null && now >= sleepDeadline!!) ||
                (chapterEndMs != null && AvidQueue.position(player) * 1000 >= chapterEndMs!!)) {
                val stopAt = chapterEndMs
                sleepDeadline = null
                chapterEndMs = null
                publishSleep()
                player.pause()
                if (stopAt != null) AvidQueue.seek(player, stopAt / 1000.0)
                checkpoint()
            }
            if (now - lastCheckpoint >= 5_000) checkpoint()
            if (now - lastAuthCheck >= 1000) {
                lastAuthCheck = now
                if (player.playWhenReady) renewCredentials()
            }
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate() {
        super.onCreate()
        AvidAudioCatalog.initialize(this)
        AvidPlaybackJournal.initialize(this)
        val cookieManager = CookieManager.getInstance()
        // A redirect must not carry Cookie/Bearer to another origin. Local/content sources still use
        // DefaultDataSource; streaming HTTP has no total-call timeout because an audiobook lasts hours.
        val mediaHttp = OkHttpDataSource.Factory(IsolatedHttp.client(callTimeoutSeconds = 0))
        val authenticatedData = ResolvingDataSource.Factory(DefaultDataSource.Factory(this, mediaHttp)) { spec ->
            val raw = spec.uri.toString()
            val scope = sourceScope.ifBlank { AvidAudioCatalog.scope }
            val epoch = sourceEpoch
            val protected = protectedSource(raw, scope)
            try {
                var token: String? = null
                if (protected) {
                    // Loader threads may await refresh; neither the player thread nor logout waits for HTTP.
                    check(Looper.myLooper() != Looper.getMainLooper())
                    val record = AvidAuth.refresh(this, scope).get(65, TimeUnit.SECONDS)
                    require(AvidAuth.isCurrent(this, scope))
                    token = record.getJSONObject("session").getString("accessToken")
                }
                val headers = mutableMapOf<String, String>()
                if (protected) cookieManager.getCookie(raw)?.takeIf { it.isNotBlank() }?.let { headers["Cookie"] = it }
                token?.let { headers["Authorization"] = "Bearer $it" }
                if (headers.isEmpty()) spec else spec.withAdditionalHeaders(headers)
            } catch (error: Exception) {
                handler.post {
                    if (!destroyed && sourceScope == scope && sourceEpoch == epoch) {
                        needsPrepareAfterAuth = true; lastAuthFailure = System.currentTimeMillis(); showAuthError()
                    }
                }
                throw IOException("Reconnect to BookOrbit to resume protected audio.", error)
            }
        }
        player = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(authenticatedData))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(30_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        player.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) { if (isPlaying) retriedUnauthorized = false; checkpoint() }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) { checkpoint() }
            override fun onTimelineChanged(timeline: Timeline, reason: Int) {
                sourceScope = player.currentMediaItem?.mediaMetadata?.extras?.getString("accountScope") ?: ""
                if (reason == Player.TIMELINE_CHANGE_REASON_PLAYLIST_CHANGED) {
                    sourceEpoch++; needsPrepareAfterAuth = false; retriedUnauthorized = false; authError = ""; lastAuthFailure = 0; publishSleep()
                }
            }
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                sourceScope = mediaItem?.mediaMetadata?.extras?.getString("accountScope") ?: ""
            }
            override fun onPlayerError(error: PlaybackException) {
                var cause: Throwable? = error
                var unauthorized = false
                while (cause != null) {
                    if (cause is HttpDataSource.InvalidResponseCodeException && cause.responseCode == 401) unauthorized = true
                    cause = cause.cause
                }
                if (unauthorized) {
                    if (!retriedUnauthorized) { retriedUnauthorized = true; needsPrepareAfterAuth = true; renewCredentials(force = true) }
                    else { lastAuthFailure = System.currentTimeMillis(); showAuthError() }
                }
            }
        })
        // Media3's default seekBack/seekForward clamps at the current file boundary.
        // Keep the playlist's native timeline for scrubbers, but make audiobook skip cross tracks.
        val sessionPlayer = object : ForwardingPlayer(player) {
            override fun seekBack() { runCatching { AvidPlaybackJournal.flush() }; AvidQueue.seek(player, AvidQueue.position(player) - 30) }
            override fun seekForward() { runCatching { AvidPlaybackJournal.flush() }; AvidQueue.seek(player, AvidQueue.position(player) + 30) }
            override fun seekTo(positionMs: Long) { runCatching { AvidPlaybackJournal.flush() }; super.seekTo(positionMs) }
            override fun seekTo(mediaItemIndex: Int, positionMs: Long) { runCatching { AvidPlaybackJournal.flush() }; super.seekTo(mediaItemIndex, positionMs) }
        }
        session = MediaLibrarySession.Builder(this, sessionPlayer, AvidLibraryCallback({ AvidControllerPolicy.allows(this, it) }) { args ->
            sleepDeadline = if (args.containsKey("deadline")) args.getLong("deadline") else null
            chapterEndMs = if (args.containsKey("chapterEndMs")) args.getLong("chapterEndMs") else null
            publishSleep()
        }).build()
        stopCatalogObserver = AvidAudioCatalog.observe { changedAccount ->
            if (changedAccount) { runCatching { AvidPlaybackJournal.flush() }; player.pause(); player.clearMediaItems(); sleepDeadline = null; chapterEndMs = null; publishSleep() }
            session?.notifyChildrenChanged(AvidLibraryCallback.ROOT, 2, null)
            session?.notifyChildrenChanged(AvidLibraryCallback.RECENT, AvidAudioCatalog.playable(recent = true).size, null)
            session?.notifyChildrenChanged(AvidLibraryCallback.LIBRARY, AvidAudioCatalog.playable().size, null)
        }
        stopAuthObserver = AvidAuth.observe { _, scope ->
            // Active connections continue playing. Every subsequent range/track request reads new cookies.
            handler.post {
                if (!destroyed && sourceScope == scope && AvidAuth.isCurrent(this, scope)) {
                    authError = ""; lastAuthFailure = 0; publishSleep()
                }
            }
        }
        handler.post(ticker)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
        if (AvidControllerPolicy.allows(this, controllerInfo)) session else null

    private fun publishSleep() {
        session?.setSessionExtras(Bundle().apply {
            sleepDeadline?.let { putLong("deadline", it) }
            chapterEndMs?.let { putLong("chapterEndMs", it) }
            putString("authError", authError)
        })
    }

    private fun protectedSource(url: String, scope: String): Boolean = try {
        val parts = org.json.JSONArray(scope)
        parts.length() == 2 && AuthPolicy.protectedMedia(url, parts.getString(0))
    } catch (_: Exception) { false }

    private fun showAuthError() {
        authError = "Your BookOrbit session could not be renewed. Reconnect to continue protected audio."
        publishSleep()
    }

    private fun renewCredentials(force: Boolean = false) {
        if (authBusy || destroyed || System.currentTimeMillis() - lastAuthFailure < 30_000) return
        val item = player.currentMediaItem ?: return
        val url = item.localConfiguration?.uri?.toString() ?: return
        val scope = item.mediaMetadata.extras?.getString("accountScope") ?: return
        if (!protectedSource(url, scope)) return
        val record = try {
            val value = AvidSessionStore.read(this)
            require(AvidAuth.isCurrent(this, scope))
            value
        } catch (_: Exception) { showAuthError(); lastAuthFailure = System.currentTimeMillis(); return }
        if (!force && !needsPrepareAfterAuth && !AvidAuth.tokenNeedsRefresh(record.getJSONObject("session"))) return
        val epoch = sourceEpoch
        authBusy = true
        AvidAuth.refresh(this, scope, record.getString("generation"), force || needsPrepareAfterAuth).whenComplete { _, error ->
            handler.post {
                authBusy = false
                if (destroyed || epoch != sourceEpoch || sourceScope != scope) return@post
                if (error != null || !AvidAuth.isCurrent(this, scope)) {
                    lastAuthFailure = System.currentTimeMillis(); showAuthError()
                } else {
                    authError = ""; lastAuthFailure = 0; publishSleep()
                    if (needsPrepareAfterAuth) {
                        needsPrepareAfterAuth = false
                        // ExoPlayer retains its latest seek, speed and playWhenReady. Do not restore an old
                        // captured position or resume a player the user paused while refresh was in flight.
                        runCatching { AvidPlaybackJournal.flush() }
                        player.prepare()
                    }
                }
            }
        }
    }

    private fun snapshot(): JSONObject? {
        val item = player.currentMediaItem ?: return null
        val extras = item.mediaMetadata.extras ?: return null
        val scope = extras.getString("accountScope") ?: return null
        return JSONObject()
            .put("accountScope", scope).put("bookId", extras.getString("bookId"))
            .put("fileId", extras.getString("fileId") ?: item.mediaId).put("position", AvidQueue.position(player))
            .put("trackId", extras.getString("trackId")).put("trackTime", player.currentPosition / 1000.0)
            .put("manifestRevision", extras.getString("manifestRevision"))
            .put("readOnly", extras.getBoolean("readOnly", true) || AvidSessionStore.readOnly(this, scope))
            .put("duration", AvidQueue.duration(player))
            .put("rate", player.playbackParameters.speed).put("playing", player.isPlaying)
            .put("updatedAt", playbackTimestamp())
    }

    private fun checkpoint() {
        val value = snapshot() ?: return
        val scope = value.getString("accountScope")
        runCatching { AvidPlaybackJournal.sample(value); AvidPlaybackJournal.recordProgress(value) }
        val hash = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it) }
        // Independent native recovery record. No media URLs or credentials are persisted.
        getSharedPreferences("avid-playback", MODE_PRIVATE).edit().putString(hash, value.toString()).apply()
        AvidAudioCatalog.checkpoint(scope, value.optString("bookId"), value.optString("fileId"),
            AvidQueue.position(player), player.playbackParameters.speed.toDouble())
        lastCheckpoint = System.currentTimeMillis()
    }

    override fun onDestroy() {
        destroyed = true
        checkpoint()
        runCatching { AvidPlaybackJournal.flush() }
        handler.removeCallbacks(ticker)
        stopCatalogObserver?.invoke()
        stopAuthObserver?.invoke()
        session?.release()
        session = null
        player.release()
        super.onDestroy()
    }

    companion object { const val SLEEP_COMMAND = "app.avid.playback.SLEEP" }
}

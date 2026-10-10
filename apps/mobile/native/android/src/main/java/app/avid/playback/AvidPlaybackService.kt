package app.avid.playback

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.ResolvingDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
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
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate() {
        super.onCreate()
        AvidAudioCatalog.initialize(this)
        AvidPlaybackJournal.initialize(this)
        val cookieManager = CookieManager.getInstance()
        val authenticatedData = ResolvingDataSource.Factory(DefaultDataSource.Factory(this)) { spec ->
            // Resolve cookies for this precise URL on every connection; never place credentials in metadata/preferences.
            val cookie = if (spec.uri.scheme in listOf("https", "http")) cookieManager.getCookie(spec.uri.toString()) else null
            if (cookie.isNullOrBlank()) spec else spec.withAdditionalHeaders(mapOf("Cookie" to cookie))
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
            override fun onIsPlayingChanged(isPlaying: Boolean) { checkpoint() }
            override fun onPositionDiscontinuity(oldPosition: Player.PositionInfo, newPosition: Player.PositionInfo, reason: Int) { checkpoint() }
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
        handler.post(ticker)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? =
        if (AvidControllerPolicy.allows(this, controllerInfo)) session else null

    private fun publishSleep() {
        session?.setSessionExtras(Bundle().apply {
            sleepDeadline?.let { putLong("deadline", it) }
            chapterEndMs?.let { putLong("chapterEndMs", it) }
        })
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
        checkpoint()
        runCatching { AvidPlaybackJournal.flush() }
        handler.removeCallbacks(ticker)
        stopCatalogObserver?.invoke()
        session?.release()
        session = null
        player.release()
        super.onDestroy()
    }

    companion object { const val SLEEP_COMMAND = "app.avid.playback.SLEEP" }
}

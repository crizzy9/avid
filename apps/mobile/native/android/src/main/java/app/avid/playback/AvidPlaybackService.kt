package app.avid.playback

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import java.security.MessageDigest
import java.time.Instant

/** Playback and checkpoints belong to the service, not to the WebView activity. */
class AvidPlaybackService : MediaLibraryService() {
    private lateinit var player: ExoPlayer
    private var session: MediaLibrarySession? = null
    private val handler = Handler(Looper.getMainLooper())
    private var sleepDeadline: Long? = null
    private var chapterEndMs: Long? = null
    private var lastCheckpoint = 0L

    private val ticker = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            if ((sleepDeadline != null && now >= sleepDeadline!!) ||
                (chapterEndMs != null && player.currentPosition >= chapterEndMs!!)) {
                val stopAt = chapterEndMs
                sleepDeadline = null
                chapterEndMs = null
                player.pause()
                if (stopAt != null) player.seekTo(stopAt)
                checkpoint()
            }
            if (now - lastCheckpoint >= 5_000) checkpoint()
            handler.postDelayed(this, 250)
        }
    }

    override fun onCreate() {
        super.onCreate()
        player = ExoPlayer.Builder(this)
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
        session = MediaLibrarySession.Builder(this, player, object : MediaLibrarySession.Callback {
            override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                val base = super.onConnect(session, controller)
                val commands = base.availableSessionCommands.buildUpon()
                if (controller.packageName == packageName) commands.add(SessionCommand(SLEEP_COMMAND, Bundle.EMPTY))
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(commands.build()).build()
            }

            override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, command: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
                if (controller.packageName != packageName || command.customAction != SLEEP_COMMAND) {
                    return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
                }
                sleepDeadline = if (args.containsKey("deadline")) args.getLong("deadline") else null
                chapterEndMs = if (args.containsKey("chapterEndMs")) args.getLong("chapterEndMs") else null
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
        }).build()
        handler.post(ticker)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    private fun checkpoint() {
        val item = player.currentMediaItem ?: return
        val extras = item.mediaMetadata.extras ?: return
        val scope = extras.getString("accountScope") ?: return
        val value = JSONObject()
            .put("accountScope", scope).put("bookId", extras.getString("bookId"))
            .put("fileId", item.mediaId).put("position", player.currentPosition / 1000.0)
            .put("duration", if (player.duration == C.TIME_UNSET) 0 else player.duration / 1000.0)
            .put("rate", player.playbackParameters.speed).put("playing", player.isPlaying)
            .put("updatedAt", Instant.now().toString())
        val hash = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray()).joinToString("") { "%02x".format(it) }
        // Independent native recovery record. No media URLs or credentials are persisted.
        getSharedPreferences("avid-playback", MODE_PRIVATE).edit().putString(hash, value.toString()).apply()
        lastCheckpoint = System.currentTimeMillis()
    }

    override fun onDestroy() {
        checkpoint()
        handler.removeCallbacks(ticker)
        session?.release()
        session = null
        player.release()
        super.onDestroy()
    }

    companion object { const val SLEEP_COMMAND = "app.avid.playback.SLEEP" }
}

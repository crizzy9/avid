package app.avid.playback

import android.content.ComponentName
import android.net.Uri
import android.os.Bundle
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionToken
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.common.util.concurrent.ListenableFuture

@CapacitorPlugin(name = "AvidPlayback")
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class AvidPlaybackPlugin : Plugin() {
    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val stateListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { notifyListeners("checkpoint", state(player)) }
    }

    override fun load() {
        AvidAudioCatalog.initialize(context)
        val token = SessionToken(context, ComponentName(context, AvidPlaybackService::class.java))
        val pending = MediaController.Builder(context, token).buildAsync()
        future = pending
        pending.addListener({
            try { controller = pending.get(); controller?.addListener(stateListener) }
            catch (_: Exception) { /* Commands report initialization failure; never claim playback started. */ }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun connected(call: PluginCall, action: (MediaController) -> Unit) {
        activity.runOnUiThread {
            val current = controller
            if (current != null) {
                try { action(current) } catch (error: Exception) { call.reject(error.message, error) }
            } else {
                val pending = future
                if (pending == null) { call.reject("Native playback service is unavailable."); return@runOnUiThread }
                pending.addListener({
                    try { action(pending.get()) } catch (error: Exception) { call.reject(error.message, error) }
                }, ContextCompat.getMainExecutor(context))
            }
        }
    }

    private fun command(call: PluginCall, action: (MediaController) -> Unit) = connected(call) {
        action(it); call.resolve()
    }

    @PluginMethod
    fun load(call: PluginCall) {
        val scope = call.getString("accountScope")
        val bookId = call.getString("bookId")
        val fileId = call.getString("fileId")
        val url = call.getString("url")
        if (scope.isNullOrBlank() || bookId.isNullOrBlank() || fileId.isNullOrBlank() || url.isNullOrBlank() ||
            Uri.parse(url).scheme !in listOf("https", "http", "file", "content")) {
            call.reject("A valid audio URL and stable account, book, and file identities are required."); return
        }
        val generation = AvidAudioCatalog.accountGeneration
        command(call) { player ->
            require(generation == AvidAudioCatalog.accountGeneration || AvidAudioCatalog.scope == scope) {
                "The account changed while the native playback service was connecting."
            }
            player.pause()
            player.sendCustomCommand(SessionCommand(AvidPlaybackService.SLEEP_COMMAND, Bundle.EMPTY), Bundle.EMPTY)
            val tracks = call.getArray("tracks")
            val source = org.json.JSONObject().put("bookId", bookId).put("fileId", fileId).put("url", url).put("tracks", tracks)
                .put("manifestRevision", call.getString("manifestRevision"))
            AvidQueue.tracks(source)
            AvidAudioCatalog.prepare(scope, bookId, fileId, url, call.getString("title") ?: "", call.getString("author") ?: "",
                (call.getDouble("position") ?: 0.0).coerceAtLeast(0.0), (call.getDouble("rate") ?: 1.0).coerceIn(0.5, 3.0), tracks, call.getString("manifestRevision"))
            val prepared = AvidAudioCatalog.get(AvidAudioCatalog.id(scope, bookId, fileId))!!
            player.setMediaItems(AvidQueue.items(prepared))
            player.prepare()
            AvidQueue.seek(player, call.getDouble("position") ?: 0.0)
            player.setPlaybackSpeed((call.getDouble("rate") ?: 1.0).coerceIn(0.5, 3.0).toFloat())
        }
    }

    @PluginMethod fun play(call: PluginCall) = command(call) { it.play() }
    @PluginMethod fun pause(call: PluginCall) = command(call) { it.pause() }
    @PluginMethod fun seek(call: PluginCall) {
        val position = call.getDouble("position")
        if (position == null || !position.isFinite()) { call.reject("A finite position is required."); return }
        command(call) { AvidQueue.seek(it, position) }
    }
    @PluginMethod fun setRate(call: PluginCall) {
        val rate = call.getDouble("rate")
        if (rate == null || !rate.isFinite()) { call.reject("A finite playback rate is required."); return }
        command(call) { it.setPlaybackSpeed(rate.coerceIn(0.5, 3.0).toFloat()) }
    }
    @PluginMethod fun setSleepTimer(call: PluginCall) {
        connected(call) { player ->
            val args = Bundle().apply {
                call.getDouble("deadline")?.let { putLong("deadline", it.toLong()) }
                call.getDouble("chapterEnd")?.let { putLong("chapterEndMs", (it * 1000).toLong()) }
            }
            val pending = player.sendCustomCommand(SessionCommand(AvidPlaybackService.SLEEP_COMMAND, Bundle.EMPTY), args)
            pending.addListener({
                try {
                    if (pending.get().resultCode == 0) call.resolve() else call.reject("Native service rejected the sleep timer.")
                } catch (error: Exception) { call.reject(error.message, error) }
            }, ContextCompat.getMainExecutor(context))
        }
    }
    @PluginMethod fun snapshot(call: PluginCall) {
        connected(call) { call.resolve(state(it)) }
    }
    @PluginMethod fun clear(call: PluginCall) = command(call) {
        it.pause(); it.clearMediaItems()
        it.sendCustomCommand(SessionCommand(AvidPlaybackService.SLEEP_COMMAND, Bundle.EMPTY), Bundle.EMPTY)
    }

    private fun state(player: Player): JSObject {
        val item = player.currentMediaItem
        return JSObject().apply {
            put("accountScope", item?.mediaMetadata?.extras?.getString("accountScope") ?: "")
            put("bookId", item?.mediaMetadata?.extras?.getString("bookId") ?: "")
            put("fileId", item?.mediaMetadata?.extras?.getString("fileId") ?: item?.mediaId ?: "")
            put("position", AvidQueue.position(player))
            put("trackTime", player.currentPosition / 1000.0)
            put("trackId", item?.mediaMetadata?.extras?.getString("trackId"))
            put("trackIndex", item?.mediaMetadata?.extras?.getInt("trackIndex") ?: 0)
            item?.mediaMetadata?.extras?.getString("manifestRevision")?.let { put("manifestRevision", it) }
            put("duration", AvidQueue.duration(player))
            put("rate", player.playbackParameters.speed); put("playing", player.isPlaying)
            put("status", when {
                player.playerError != null -> "failed"
                player.playbackState == Player.STATE_BUFFERING -> "buffering"
                player.isPlaying -> "playing"
                player.playbackState == Player.STATE_IDLE -> "stopped"
                else -> "paused"
            })
            put("error", player.playerError?.message ?: "")
            put("ended", player.playbackState == Player.STATE_ENDED)
            put("updatedAt", playbackTimestamp())
        }
    }

    override fun handleOnDestroy() {
        controller?.removeListener(stateListener)
        future?.let { MediaController.releaseFuture(it) }
        controller = null
        // Release the interface's connection, not the service-owned player.
        super.handleOnDestroy()
    }
}

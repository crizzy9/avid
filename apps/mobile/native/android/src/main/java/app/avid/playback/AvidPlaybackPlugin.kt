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
import java.time.Instant

@CapacitorPlugin(name = "AvidPlayback")
class AvidPlaybackPlugin : Plugin() {
    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private val stateListener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) { notifyListeners("checkpoint", state(player)) }
    }

    override fun load() {
        val token = SessionToken(context, ComponentName(context, AvidPlaybackService::class.java))
        val pending = MediaController.Builder(context, token).buildAsync()
        future = pending
        pending.addListener({
            try { controller = pending.get(); controller?.addListener(stateListener) }
            catch (_: Exception) { /* Commands report initialization failure; never claim playback started. */ }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun command(call: PluginCall, action: (MediaController) -> Unit) {
        activity.runOnUiThread {
            val player = controller
            if (player == null) { call.reject("Native playback service is not connected yet."); return@runOnUiThread }
            try { action(player); call.resolve() } catch (error: Exception) { call.reject(error.message, error) }
        }
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
        command(call) { player ->
            player.pause()
            player.sendCustomCommand(SessionCommand(AvidPlaybackService.SLEEP_COMMAND, Bundle.EMPTY), Bundle.EMPTY)
            val extras = Bundle().apply { putString("accountScope", scope); putString("bookId", bookId) }
            val metadata = MediaMetadata.Builder().setTitle(call.getString("title") ?: "")
                .setArtist(call.getString("author") ?: "").setExtras(extras).build()
            player.setMediaItem(MediaItem.Builder().setMediaId(fileId).setUri(url).setMediaMetadata(metadata).build())
            player.prepare()
            player.seekTo(((call.getDouble("position") ?: 0.0).coerceAtLeast(0.0) * 1000).toLong())
            player.setPlaybackSpeed((call.getDouble("rate") ?: 1.0).coerceIn(0.5, 3.0).toFloat())
        }
    }

    @PluginMethod fun play(call: PluginCall) = command(call) { it.play() }
    @PluginMethod fun pause(call: PluginCall) = command(call) { it.pause() }
    @PluginMethod fun seek(call: PluginCall) {
        val position = call.getDouble("position")
        if (position == null || !position.isFinite()) { call.reject("A finite position is required."); return }
        command(call) { it.seekTo((position.coerceAtLeast(0.0) * 1000).toLong()) }
    }
    @PluginMethod fun setRate(call: PluginCall) {
        val rate = call.getDouble("rate")
        if (rate == null || !rate.isFinite()) { call.reject("A finite playback rate is required."); return }
        command(call) { it.setPlaybackSpeed(rate.coerceIn(0.5, 3.0).toFloat()) }
    }
    @PluginMethod fun setSleepTimer(call: PluginCall) {
        activity.runOnUiThread {
            val player = controller
            if (player == null) { call.reject("Native playback service is not connected yet."); return@runOnUiThread }
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
        activity.runOnUiThread {
            controller?.let { call.resolve(state(it)) } ?: call.reject("Native playback service is not connected yet.")
        }
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
            put("fileId", item?.mediaId ?: "")
            put("position", player.currentPosition / 1000.0)
            put("duration", if (player.duration == C.TIME_UNSET) 0 else player.duration / 1000.0)
            put("rate", player.playbackParameters.speed); put("playing", player.isPlaying)
            put("updatedAt", Instant.now().toString())
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

package app.avid.playback

import android.os.Bundle
import android.os.Process
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService.LibraryParams
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject

/** The same catalog contract serves Media3 browsers and Android Auto's legacy MediaBrowserService bridge. */
@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
class AvidLibraryCallback(private val context: android.content.Context, private val allowed: (MediaSession.ControllerInfo) -> Boolean,
    private val remote: (Bundle) -> Unit, private val sleep: (Bundle) -> Unit) : MediaLibrarySession.Callback {
    private fun own(controller: MediaSession.ControllerInfo) = controller.uid == Process.myUid()
    override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
        if (!allowed(controller)) return MediaSession.ConnectionResult.reject()
        val commands = MediaSession.ConnectionResult.DEFAULT_SESSION_AND_LIBRARY_COMMANDS.buildUpon()
        if (own(controller)) { commands.add(SessionCommand(AvidPlaybackService.SLEEP_COMMAND, Bundle.EMPTY)); commands.add(SessionCommand(AvidPlaybackService.REMOTE_COMMAND, Bundle.EMPTY)) }
        val playerCommands = MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon()
        // Car clients select a book; they cannot append/reorder/remove the private source-track queue.
        if (!own(controller)) playerCommands.remove(Player.COMMAND_CHANGE_MEDIA_ITEMS)
        return MediaSession.ConnectionResult.AcceptedResultBuilder(session).setAvailableSessionCommands(commands.build())
            .setAvailablePlayerCommands(playerCommands.build()).build()
    }
    override fun onCustomCommand(session: MediaSession, controller: MediaSession.ControllerInfo, command: SessionCommand, args: Bundle): ListenableFuture<SessionResult> {
        if (!own(controller)) return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
        return try {
            when (command.customAction) {
                AvidPlaybackService.SLEEP_COMMAND -> sleep(args)
                AvidPlaybackService.REMOTE_COMMAND -> remote(args)
                else -> return Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_NOT_SUPPORTED))
            }
            Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
        } catch (_: Exception) { Futures.immediateFuture(SessionResult(SessionResult.RESULT_ERROR_BAD_VALUE)) }
    }
    override fun onGetLibraryRoot(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, params: LibraryParams?): ListenableFuture<LibraryResult<MediaItem>> {
        return Futures.immediateFuture(LibraryResult.ofItem(folder(ROOT, "Avid"), params))
    }
    override fun onGetItem(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, mediaId: String): ListenableFuture<LibraryResult<MediaItem>> {
        val item = when (mediaId) {
            ROOT -> folder(ROOT, "Avid")
            RECENT -> folder(RECENT, AvidStrings.text(context, "Continue listening"))
            LIBRARY -> folder(LIBRARY, AvidStrings.text(context, "Prepared audiobooks"))
            else -> AvidAudioCatalog.get(mediaId)?.takeIf { it.optString("url").isNotBlank() }?.let { item(it, false) }
        }
        return Futures.immediateFuture(if (item == null) LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE) else LibraryResult.ofItem(item, null))
    }
    override fun onGetChildren(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
        if (AvidAudioCatalog.scope.isBlank()) return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_SESSION_AUTHENTICATION_EXPIRED))
        return try {
            val children = when (parentId) {
                ROOT -> listOf(folder(RECENT, AvidStrings.text(context, "Continue listening")), folder(LIBRARY, AvidStrings.text(context, "Prepared audiobooks")))
                RECENT -> AvidAudioCatalog.playable(recent = true).map { item(it, false) }
                LIBRARY -> AvidAudioCatalog.playable().map { item(it, false) }
                else -> return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
            }
            Futures.immediateFuture(LibraryResult.ofItemList(catalogPage(children, page, pageSize), params))
        } catch (_: IllegalArgumentException) { Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)) }
    }
    override fun onSubscribe(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, parentId: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
        if (parentId !in listOf(ROOT, RECENT, LIBRARY)) return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
        val count = if (parentId == ROOT) 2 else AvidAudioCatalog.playable(recent = parentId == RECENT).size
        session.notifyChildrenChanged(browser, parentId, count, params)
        return Futures.immediateFuture(LibraryResult.ofVoid(params))
    }
    override fun onSearch(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, params: LibraryParams?): ListenableFuture<LibraryResult<Void>> {
        if (query.isBlank() || query.length > 200) return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
        session.notifySearchResultChanged(browser, query, AvidAudioCatalog.playable(query).size, params)
        return Futures.immediateFuture(LibraryResult.ofVoid(params))
    }
    override fun onGetSearchResult(session: MediaLibrarySession, browser: MediaSession.ControllerInfo, query: String, page: Int, pageSize: Int, params: LibraryParams?): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
        return try {
            require(query.isNotBlank() && query.length <= 200)
            Futures.immediateFuture(LibraryResult.ofItemList(catalogPage(AvidAudioCatalog.playable(query).map { item(it, false) }, page, pageSize), params))
        } catch (_: IllegalArgumentException) { Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)) }
    }
    override fun onAddMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>): ListenableFuture<List<MediaItem>> {
        return try { Futures.immediateFuture(resolve(controller, mediaItems)) }
        catch (error: Exception) { Futures.immediateFailedFuture(error) }
    }
    override fun onSetMediaItems(session: MediaSession, controller: MediaSession.ControllerInfo, mediaItems: List<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
        return try {
            val items = resolve(controller, mediaItems)
            // A new selection starts a new sleep policy; automatic track advances do not call this.
            sleep(Bundle.EMPTY)
            if (own(controller) && mediaItems.all { it.localConfiguration != null }) {
                Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(items, startIndex, startPositionMs))
            } else {
                val source = AvidAudioCatalog.get(items.first().mediaId) ?: error("Source is unavailable")
                val seconds = if (startPositionMs == C.TIME_UNSET) source.optDouble("position", 0.0) else startPositionMs.coerceAtLeast(0) / 1000.0
                val target = AudioTimeline.locate(AvidQueue.tracks(source).map { if (it.has("duration")) it.getDouble("duration") else null }, seconds)
                session.player.setPlaybackSpeed(source.optDouble("rate", 1.0).coerceIn(0.5, 3.0).toFloat())
                Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(items, target.index, (target.offset * 1000).toLong()))
            }
        } catch (error: Exception) { Futures.immediateFailedFuture(error) }
    }
    override fun onPlaybackResumption(session: MediaSession, controller: MediaSession.ControllerInfo): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
        val recent = AvidAudioCatalog.playable(recent = true).firstOrNull()
            ?: return Futures.immediateFailedFuture(IllegalStateException("Open an audiobook in Avid before resuming it from the car."))
        try { AvidQueue.validateSources(context, recent, AvidAudioCatalog.scope) }
        catch (error: Exception) { return Futures.immediateFailedFuture(error) }
        sleep(Bundle.EMPTY)
        val target = AudioTimeline.locate(AvidQueue.tracks(recent).map { if (it.has("duration")) it.getDouble("duration") else null }, recent.optDouble("position", 0.0))
        session.player.setPlaybackSpeed(recent.optDouble("rate", 1.0).coerceIn(0.5, 3.0).toFloat())
        return Futures.immediateFuture(MediaSession.MediaItemsWithStartPosition(AvidQueue.items(recent), target.index, (target.offset * 1000).toLong()))
    }
    private fun resolve(controller: MediaSession.ControllerInfo, values: List<MediaItem>): List<MediaItem> {
        require(values.isNotEmpty())
        if (!(own(controller) && values.all { it.localConfiguration != null })) require(values.size == 1) { "Choose one audiobook at a time." }
        return values.flatMap { value ->
            if (own(controller) && value.localConfiguration != null) {
                val extra = value.mediaMetadata.extras
                val url = value.localConfiguration!!.uri.toString()
                if (value.localConfiguration!!.uri.scheme in listOf("file", "content")) require(AvidMediaStore.validate(context, url,
                    MediaIdentity(extra?.getString("accountScope") ?: "", extra?.getString("bookId") ?: "", extra?.getString("fileId") ?: "", extra?.getString("trackId") ?: "")))
                listOf(value)
            }
            else {
                val query = value.requestMetadata.searchQuery
                val source = if (!query.isNullOrBlank()) {
                    val matches = AvidAudioCatalog.playable(query)
                    val exact = matches.filter { it.optString("title").equals(query, ignoreCase = true) }
                    if (exact.size == 1) exact.first() else if (matches.size == 1) matches.first() else null
                } else AvidAudioCatalog.get(value.mediaId)
                if (source == null) throw IllegalArgumentException("Unknown, ambiguous, or different-account audio ID.")
                require(source.optString("url").isNotBlank()) { "Open this audiobook in Avid first." }
                AvidQueue.validateSources(context, source, AvidAudioCatalog.scope)
                AvidQueue.items(source)
            }
        }
    }
    companion object {
        const val ROOT = "avid:root"
        const val RECENT = "avid:recent"
        const val LIBRARY = "avid:library"
        private fun folder(id: String, title: String): MediaItem = MediaItem.Builder().setMediaId(id)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).setIsBrowsable(true).setIsPlayable(false)
                .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_AUDIO_BOOKS).build()).build()
        fun item(source: JSONObject, playableSource: Boolean): MediaItem {
            val extras = Bundle().apply {
                putString("accountScope", AvidAudioCatalog.scope); putString("bookId", source.getString("bookId")); putString("fileId", source.getString("fileId"))
            }
            val builder = MediaItem.Builder().setMediaId(source.getString("id"))
                .setMediaMetadata(MediaMetadata.Builder().setTitle(source.optString("title")).setArtist(source.optString("author"))
                    .setIsBrowsable(false).setIsPlayable(true).setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK).setExtras(extras).build())
            // Stream URLs are resolved inside the service and never exposed by browse/search responses.
            if (playableSource) builder.setUri(source.getString("url"))
            return builder.build()
        }
    }
}

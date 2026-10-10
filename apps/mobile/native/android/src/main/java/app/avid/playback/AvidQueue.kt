package app.avid.playback

import android.net.Uri
import android.os.Bundle
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import org.json.JSONArray
import org.json.JSONObject

object AvidQueue {
    fun tracks(source: JSONObject): List<JSONObject> {
        val values = source.optJSONArray("tracks") ?: JSONArray().put(JSONObject().put("id", source.getString("fileId")).put("url", source.getString("url")))
        val tracks = (0 until values.length()).map { values.getJSONObject(it) }
        require(tracks.map { it.getString("id") }.toSet().size == tracks.size)
        tracks.forEach { require(it.getString("id").isNotBlank() && Uri.parse(it.getString("url")).scheme in listOf("https", "http", "file", "content")) }
        AudioTimeline.validate(tracks.map { duration(it) })
        return tracks
    }
    private fun duration(value: JSONObject): Double? = if (value.has("duration") && !value.isNull("duration")) value.getDouble("duration") else null
    fun items(source: JSONObject): List<MediaItem> {
        val tracks = tracks(source)
        val durations = tracks.map { duration(it) }
        val total = if (durations.all { it != null }) durations.sumOf { it!! } else 0.0
        return tracks.mapIndexed { index, track ->
            val extras = Bundle().apply {
                putString("accountScope", AvidAudioCatalog.scope); putString("bookId", source.getString("bookId")); putString("fileId", source.getString("fileId"))
                putString("trackId", track.getString("id")); putInt("trackIndex", index); putInt("trackCount", tracks.size)
                putDouble("trackStart", AudioTimeline.start(durations, index)); putDouble("timelineDuration", total)
                duration(track)?.let { putDouble("trackDuration", it) }
                if (source.has("manifestRevision")) putString("manifestRevision", source.getString("manifestRevision"))
            }
            MediaItem.Builder().setMediaId(source.getString("id")).setUri(track.getString("url"))
                .setMediaMetadata(MediaMetadata.Builder().setTitle(source.optString("title")).setArtist(source.optString("author"))
                    .setIsPlayable(true).setIsBrowsable(false).setMediaType(MediaMetadata.MEDIA_TYPE_AUDIO_BOOK).setExtras(extras).build()).build()
        }
    }
    fun position(player: Player): Double = (player.currentMediaItem?.mediaMetadata?.extras?.getDouble("trackStart") ?: 0.0) + player.currentPosition / 1000.0
    fun duration(player: Player): Double {
        val extras = player.currentMediaItem?.mediaMetadata?.extras ?: return 0.0
        val total = extras.getDouble("timelineDuration")
        if (total > 0) return total
        return if (extras.getInt("trackIndex") == extras.getInt("trackCount") - 1 && player.duration != C.TIME_UNSET)
            extras.getDouble("trackStart") + player.duration / 1000.0 else 0.0
    }
    fun seek(player: Player, seconds: Double) {
        val durations = (0 until player.mediaItemCount).map { index -> player.getMediaItemAt(index).mediaMetadata.extras?.let { if (it.containsKey("trackDuration")) it.getDouble("trackDuration") else null } }
        if (durations.isEmpty()) return
        val target = AudioTimeline.locate(durations, seconds)
        player.seekTo(target.index, (target.offset * 1000).toLong())
    }
}

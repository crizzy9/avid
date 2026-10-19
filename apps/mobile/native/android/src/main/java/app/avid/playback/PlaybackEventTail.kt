package app.avid.playback

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Process-owned bounded history. It never stores URLs, credentials, text or a full offline journal. */
internal class PlaybackEventTail {
    private var sourceKey = ""
    private var ownerId = UUID.randomUUID().toString()
    private var sequence = 0L
    private val events = ArrayDeque<JSONObject>()
    private var identity: JSONObject? = null
    fun reset() { sourceKey = ""; identity = null; events.clear(); sequence = 0; ownerId = UUID.randomUUID().toString() }
    fun record(source: JSONObject, kind: String, reason: String, from: Double, to: Double, rate: Double, status: String) {
        val scope = source.optString("accountScope")
        val book = source.optString("bookId")
        val file = source.optString("fileId")
        if (scope.isBlank() || book.isBlank() || file.isBlank() || !from.isFinite() || !to.isFinite() || from < 0 || to < 0 || !rate.isFinite()) return
        val revision = source.optString("manifestRevision", "")
        val key = JSONArray(listOf(scope, book, file, revision)).toString()
        if (key != sourceKey) {
            reset(); sourceKey = key
            identity = JSONObject().put("accountScope", scope).put("bookId", book).put("fileId", file)
                .put("manifestRevision", revision.ifEmpty { null } ?: JSONObject.NULL)
        }
        events.addLast(JSONObject().put("sequence", ++sequence).put("kind", kind).put("reason", reason)
            .put("observedAt", playbackTimestamp()).put("fromSourceSeconds", from).put("toSourceSeconds", to)
            .put("rate", rate).put("status", status))
        while (events.size > 64) events.removeFirst()
    }
    fun snapshot(): JSONObject? = identity?.let { source -> JSONObject(source.toString()).put("version", 1).put("ownerId", ownerId).put("events", JSONArray(events.map { JSONObject(it.toString()) })) }
}

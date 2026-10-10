package app.avid.playback

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

internal object JournalPlaybackTiming {
    fun interval(elapsed: Double, sourceDelta: Double, rate: Double): Double {
        if (!elapsed.isFinite() || !sourceDelta.isFinite() || !rate.isFinite() || rate <= 0 || rate > 4 ||
            elapsed <= 0 || elapsed > 2 || sourceDelta <= 0) return 0.0
        val expected = elapsed * rate
        return if (abs(sourceDelta - expected) <= max(0.25, expected * 0.5)) elapsed else 0.0
    }
}

/** Durable playback metadata. Neither media URLs nor credentials enter this journal. */
object AvidPlaybackJournal {
    /** Sticky until a durable insertion succeeds; a no-op sample must not hide lost durability. */
    @Volatile var recoveryError: String? = null
        private set
    private var helper: Store? = null
    private var previous: Sample? = null
    private var activity: Activity? = null
    private var needsFlush = false
    private var lastProgress: String? = null
    private data class Sample(val scope: String, val bookId: String, val fileId: String, val revision: String,
        val position: Double, val rate: Double, val monotonic: Double, val wall: Long, val playing: Boolean, val readOnly: Boolean) {
        val identity get() = listOf(scope, bookId, fileId, revision, readOnly.toString())
    }
    private data class Activity(val source: Sample, val startedAt: Long, var duration: Double)
    private class Store(context: Context) : SQLiteOpenHelper(context,
        File(context.noBackupFilesDir, "avid-playback-journal.sqlite").absolutePath, null, 1) {
        override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
        override fun onCreate(db: SQLiteDatabase) {
            db.execSQL("CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, account_scope TEXT NOT NULL, book_id TEXT NOT NULL, file_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('progress','activity')), created_at TEXT NOT NULL, payload TEXT NOT NULL, read_only INTEGER NOT NULL DEFAULT 1)")
            db.execSQL("CREATE INDEX events_scope_sequence ON events(account_scope, sequence)")
        }
        override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
            error("Unsupported playback journal version")
        }
    }
    @Synchronized fun initialize(context: Context) {
        if (helper == null) helper = Store(context.applicationContext).apply { setWriteAheadLoggingEnabled(true) }
    }
    private fun database(): SQLiteDatabase = checkNotNull(helper) { "The playback journal is not initialized." }.writableDatabase
    private fun timestamp(milliseconds: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(milliseconds))
    private fun validTimestamp(value: String): Boolean {
        if (!value.matches(Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$"))) return false
        return try {
            SimpleDateFormat(if (value.contains('.')) "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'" else "yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC"); isLenient = false }.parse(value) != null
        } catch (_: Exception) { false }
    }
    private fun insert(source: Sample, type: String, createdAt: String, payload: JSONObject, id: String = UUID.randomUUID().toString()) {
        val values = ContentValues().apply {
            put("id", id); put("account_scope", source.scope); put("book_id", source.bookId); put("file_id", source.fileId)
            put("event_type", type); put("created_at", createdAt); put("payload", payload.toString()); put("read_only", if (source.readOnly) 1 else 0)
        }
        try {
            database().insertOrThrow("events", null, values)
            recoveryError = null
        } catch (error: Exception) {
            recoveryError = "Playback continues, but progress and listening time could not be saved on this device. Keep Avid open until storage recovers."
            throw error
        }
    }
    private fun readSample(value: JSONObject): Sample? {
        val scope = value.optString("accountScope"); val book = value.optString("bookId"); val file = value.optString("fileId")
        if (scope.isBlank() || scope.length > 4096 || book.isBlank() || book.length > 512 || file.isBlank() || file.length > 512) return null
        val position = value.optDouble("position", Double.NaN); val rate = value.optDouble("rate", 1.0)
        if (!position.isFinite() || position < 0 || !rate.isFinite() || rate <= 0 || rate > 4) return null
        val status = value.optString("status")
        return Sample(scope, book, file, value.optString("manifestRevision"), position, rate,
            SystemClock.elapsedRealtimeNanos() / 1_000_000_000.0, System.currentTimeMillis(),
            value.optBoolean("playing") && (status.isBlank() || status == "playing"), value.optBoolean("readOnly", true))
    }
    @Synchronized fun recordProgress(value: JSONObject) {
        val source = readSample(value) ?: return
        val track = value.optString("trackId"); val trackTime = value.optDouble("trackTime", Double.NaN)
        val updatedAt = value.optString("updatedAt")
        if (track.isBlank() || track.length > 512 || !trackTime.isFinite() || trackTime < 0 || !validTimestamp(updatedAt)) return
        val locator = JSONObject().put("version", 1).put("trackId", track).put("trackTime", trackTime).put("time", source.position)
        if (source.revision.isNotBlank()) locator.put("manifestRevision", source.revision)
        val fingerprint = JSONArray(source.identity + locator.toString()).toString()
        if (fingerprint == lastProgress) return
        val duration = value.optDouble("duration", 0.0)
        val progress = if (duration.isFinite() && duration > 0) (source.position / duration).coerceIn(0.0, 1.0) else 0.0
        insert(source, "progress", updatedAt, JSONObject().put("bookId", source.bookId).put("fileId", source.fileId)
            .put("kind", "audio").put("locator", locator.toString()).put("progress", progress).put("updatedAt", updatedAt))
        lastProgress = fingerprint
    }
    /** Flush immediately before explicit seeks and source replacement; sampling never infers elapsed time across them. */
    @Synchronized fun sample(value: JSONObject) {
        if (needsFlush) { previous = null; flushActivity() }
        val current = readSample(value)
        if (current == null) { flush(); return }
        val prior = previous
        previous = current
        if (prior == null) return
        val elapsed = current.monotonic - prior.monotonic
        val delta = current.position - prior.position
        if (current.identity != prior.identity || !current.playing || !prior.playing || current.rate != prior.rate ||
            JournalPlaybackTiming.interval(elapsed, delta, prior.rate) == 0.0 || current.wall < prior.wall) {
            flushActivity(); return
        }
        var remaining = elapsed
        var intervalStart = prior.wall
        while (remaining > 0.000001) {
            if (activity == null) activity = Activity(prior, intervalStart, 0.0)
            val chunk = checkNotNull(activity)
            val portion = min(remaining, 15 - chunk.duration)
            chunk.duration += portion
            remaining -= portion; intervalStart += (portion * 1000).toLong()
            if (chunk.duration >= 15 - 0.000001) flushActivity()
        }
    }
    private fun flushActivity() {
        val chunk = activity ?: return
        if (chunk.duration <= 0) { activity = null; return }
        needsFlush = true
        val id = UUID.randomUUID().toString()
        val ended = timestamp(chunk.startedAt + (chunk.duration * 1000).toLong())
        insert(chunk.source, "activity", ended, JSONObject().put("id", id).put("bookId", chunk.source.bookId)
            .put("kind", "listening").put("startedAt", timestamp(chunk.startedAt)).put("duration", min(15.0, chunk.duration)).put("endedAt", ended), id)
        activity = null
        needsFlush = false
    }
    @Synchronized fun flush() { previous = null; flushActivity() }
    @Synchronized fun recordAnchor(accountScope: String, anchor: JSONObject, readOnly: Boolean): String {
        requireScope(accountScope)
        val book = anchor.getString("bookId"); val file = anchor.getString("fileId"); val kind = anchor.getString("kind")
        val locator = anchor.getString("locator"); val progress = anchor.getDouble("progress"); val updatedAt = anchor.getString("updatedAt")
        require(book.isNotBlank() && book.length <= 512 && file.isNotBlank() && file.length <= 512 && kind in listOf("epub", "pdf", "comic", "audio") &&
            locator.isNotEmpty() && locator.toByteArray(Charsets.UTF_8).size <= 65536 && progress.isFinite() && progress in 0.0..1.0 && validTimestamp(updatedAt)) { "Invalid reading checkpoint." }
        if (kind == "audio") {
            val value = JSONObject(locator)
            require(value.getInt("version") == 1 && value.getString("trackId").isNotBlank() &&
                value.getDouble("trackTime").let { it.isFinite() && it >= 0 } && value.getDouble("time").let { it.isFinite() && it >= 0 }) { "An exact audio locator is required." }
        }
        val id = UUID.randomUUID().toString()
        val source = Sample(accountScope, book, file, "", 0.0, 1.0, 0.0, 0, false, readOnly)
        insert(source, "progress", updatedAt, JSONObject().put("bookId", book).put("fileId", file).put("kind", kind)
            .put("locator", locator).put("progress", progress).put("updatedAt", updatedAt), id)
        return id
    }
    private fun requireScope(scope: String) { require(scope.isNotBlank() && scope.length <= 4096) { "An account scope is required." } }
    @Synchronized fun drain(accountScope: String, limit: Int = 200): JSONArray {
        requireScope(accountScope); require(limit in 1..200) { "Drain between 1 and 200 events." }
        val events = JSONArray()
        database().query("events", arrayOf("id", "account_scope", "book_id", "file_id", "event_type", "created_at", "payload", "read_only"),
            "account_scope = ?", arrayOf(accountScope), null, null, "sequence ASC", limit.toString()).use { cursor ->
            while (cursor.moveToNext()) events.put(JSONObject().put("id", cursor.getString(0)).put("accountScope", cursor.getString(1))
                .put("bookId", cursor.getString(2)).put("fileId", cursor.getString(3)).put("type", cursor.getString(4))
                .put("createdAt", cursor.getString(5)).put("payload", JSONObject(cursor.getString(6))).put("readOnly", cursor.getInt(7) != 0))
        }
        return events
    }
    @Synchronized fun ack(accountScope: String, ids: List<String>) {
        requireScope(accountScope)
        require(ids.size <= 200 && ids.toSet().size == ids.size && ids.all { it.isNotBlank() && it.length <= 128 }) { "At most 200 unique journal IDs are allowed." }
        val db = database()
        db.beginTransaction()
        try {
            ids.forEach { id ->
                db.query("events", arrayOf("account_scope"), "id = ?", arrayOf(id), null, null, null).use { cursor ->
                    require(!cursor.moveToFirst() || cursor.getString(0) == accountScope) { "A journal event belongs to a different account." }
                }
            }
            ids.forEach { db.delete("events", "id = ? AND account_scope = ?", arrayOf(it, accountScope)) }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
}

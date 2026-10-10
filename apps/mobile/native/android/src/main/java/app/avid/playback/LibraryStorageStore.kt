package app.avid.playback

import android.database.sqlite.SQLiteDatabase
import android.os.Build
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.net.URI
import java.util.UUID

internal class LibraryStorageException(message: String) : IllegalArgumentException(message)

/** Local metadata partitions are independent of login authority, including captured old-account writes.
 * Only incomplete binary transfers are bound to a connection epoch. No network or arbitrary paths. */
internal class LibraryStorageStore(root: File, private val now: () -> Long = System::currentTimeMillis) : Closeable {
    private val root = root.absoluteFile
    private val files = File(this.root, "blobs")
    private val processId = UUID.randomUUID().toString()
    private val database: SQLiteDatabase

    init {
        privateDirectory(this.root); privateDirectory(files)
        val path = File(this.root, "library.sqlite3")
        listOf("", "-wal", "-shm").forEach { regularOptional(File(this.root, "library.sqlite3$it")) }
        if (!path.exists()) check(path.createNewFile())
        Os.chmod(path.absolutePath, 0x180) // 0600, before SQLite creates WAL/SHM.
        val flags = SQLiteDatabase.OPEN_READWRITE or SQLiteDatabase.CREATE_IF_NECESSARY or SQLiteDatabase.ENABLE_WRITE_AHEAD_LOGGING
        database = when {
            // Pool replacements inherit FULL, instead of reverting to an OEM WAL default.
            Build.VERSION.SDK_INT >= 28 -> SQLiteDatabase.openDatabase(path, SQLiteDatabase.OpenParams.Builder()
                .setOpenFlags(flags).setJournalMode("WAL").setSynchronousMode("FULL").build())
            // API27 introduced idle eviction but not the synchronous OpenParams setting. Disable
            // eviction so the explicit FULL pragma below stays on the write connection.
            Build.VERSION.SDK_INT == 27 -> SQLiteDatabase.openDatabase(path, SQLiteDatabase.OpenParams.Builder()
                .setOpenFlags(flags).setIdleConnectionTimeout(Long.MAX_VALUE).build())
            // API24-26 do not have idle-connection eviction.
            else -> SQLiteDatabase.openDatabase(path.absolutePath, null, flags)
        }
        try {
            database.setForeignKeyConstraintsEnabled(true)
            database.execSQL("PRAGMA synchronous=FULL")
            database.rawQuery("PRAGMA busy_timeout=5000", null).use { it.moveToFirst() }
            val version = scalar("PRAGMA user_version").toLong()
            valid(version <= 1, "This library store requires a newer Avid version.")
            if (version == 0L) transaction {
                database.execSQL("CREATE TABLE IF NOT EXISTS revisions(scope TEXT NOT NULL, table_name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), PRIMARY KEY(scope,table_name))")
                database.execSQL("CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), mime TEXT NOT NULL, name TEXT NOT NULL, state INTEGER NOT NULL CHECK(state IN(0,1)), offset INTEGER NOT NULL, created_at INTEGER NOT NULL, process_id TEXT NOT NULL, epoch TEXT NOT NULL)")
                database.execSQL("CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, table_name TEXT NOT NULL, id TEXT NOT NULL, row_key TEXT NOT NULL, json TEXT NOT NULL, entity_key TEXT, blob_id TEXT REFERENCES blobs(id), PRIMARY KEY(scope,table_name,id))")
                database.execSQL("CREATE INDEX IF NOT EXISTS record_entity ON records(scope,table_name,entity_key)")
                database.execSQL("CREATE INDEX IF NOT EXISTS record_blob ON records(blob_id)")
                database.execSQL("CREATE INDEX IF NOT EXISTS blob_scope ON blobs(scope)")
                database.execSQL("PRAGMA user_version=1")
            }
            syncDirectory(this.root)
        } catch (error: Exception) { database.close(); throw error }
    }

    @Synchronized fun read(request: JSONObject): JSONObject {
        fields(request, setOf("scope", "table"), setOf("query"))
        val scope = scope(string(request, "scope")); val table = table(string(request, "table"))
        val query = if (request.has("query")) objectValue(request, "query") else JSONObject()
        fields(query, emptySet(), setOf("ids", "entityKey", "keysOnly"))
        val entity = if (query.has("entityKey")) string(query, "entityKey").also {
            valid(table == "outbox" && utf8(it) <= 131072, "entityKey is only valid for bounded outbox queries.")
        } else null
        val keysOnly = if (query.has("keysOnly")) boolean(query, "keysOnly") else false
        val ids = if (query.has("ids")) arrayValue(query, "ids").let { values ->
            valid(values.length() <= 10000, "Too many requested library rows.")
            (0 until values.length()).map { identity(strictString(values.get(it))) }.toSet()
        } else null
        return transaction {
            val revision = revision(scope, table)
            val rows = JSONArray()
            if (ids?.isEmpty() != true) {
                var bytes = 0L
                // Android's CursorWindow has a small per-row limit. Cursor over identities only;
                // simpleQueryForString reads bounded JSON directly, including records above 2 MiB.
                // API24 SQLite allows fewer bound variables than desktop SQLite. Batch ID predicates
                // inside one transaction instead of scanning every book for a receipt/anchor lookup.
                val batches: List<List<String>?> = ids?.sorted()?.chunked(400) ?: listOf(null)
                database.compileStatement("SELECT json FROM records WHERE scope=? AND table_name=? AND id=?").use { payload ->
                    payload.bindString(1, scope); payload.bindString(2, table)
                    for (batch in batches) {
                        val selection = "scope=? AND table_name=?" + (if (entity == null) "" else " AND entity_key=?") +
                            (if (batch == null) "" else " AND id IN (${batch.joinToString(",") { "?" }})")
                        val arguments = (listOfNotNull(scope, table, entity) + batch.orEmpty()).toTypedArray()
                        database.query("records", arrayOf("id", "row_key"), selection, arguments, null, null, "id").use { cursor ->
                            while (cursor.moveToNext()) {
                                val id = cursor.getString(0)
                                valid(rows.length() < MAX_ROWS, "The library snapshot is too large; request rows in batches.")
                                val row = if (keysOnly) JSONObject().put("key", cursor.getString(1)).put("scope", scope).put("id", id)
                                else { payload.bindString(3, id); JSONObject(payload.simpleQueryForString()) }
                                bytes += utf8(row.toString())
                                valid(bytes <= MAX_BATCH_BYTES, "The library snapshot is too large; request rows in batches.")
                                rows.put(row)
                            }
                        }
                    }
                }
            }
            JSONObject().put("revision", revision.toString()).put("rows", rows)
        }
    }

    @Synchronized fun commit(request: JSONObject): JSONObject {
        fields(request, setOf("scope", "expected", "mutations"))
        val scope = scope(string(request, "scope")); val expected = objectValue(request, "expected")
        val revisions = expected.keys().asSequence().associate { table(it) to parseRevision(string(expected, it)) }
        val mutations = arrayValue(request, "mutations")
        valid(mutations.length() <= MAX_ROWS, "Too many library mutations.")
        val changed = mutableSetOf<String>()
        var bytes = 0L
        for (index in 0 until mutations.length()) {
            val mutation = strictObject(mutations.get(index)); val table = table(string(mutation, "table"))
            changed.add(table); valid(revisions.containsKey(table), "Every changed table requires an expected revision.")
            when (string(mutation, "type")) {
                "put" -> {
                    fields(mutation, setOf("type", "table", "row"))
                    val length = utf8(objectValue(mutation, "row").toString())
                    valid(length <= MAX_ROW_BYTES, "Library record is too large."); bytes += length
                }
                "delete" -> fields(mutation, setOf("type", "table", "id"))
                "clear" -> fields(mutation, setOf("type", "table"))
                else -> throw LibraryStorageException("Invalid library mutation.")
            }
        }
        valid(bytes <= MAX_BATCH_BYTES, "Library transaction is too large.")
        return transaction {
            if (revisions.any { (table, expected) -> revision(scope, table) != expected })
                return@transaction JSONObject().put("committed", false)
            for (index in 0 until mutations.length()) {
                val mutation = mutations.getJSONObject(index); val table = mutation.getString("table")
                when (mutation.getString("type")) {
                    "put" -> {
                        val row = mutation.getJSONObject("row"); val id = rowIdentity(scope, row)
                        val blobId = if (table == "localFiles") validateReference(scope, row) else null
                        val entity = if (table == "outbox" && row.opt("entityKey") is String) row.getString("entityKey") else null
                        // Android API24 SQLite predates UPSERT. No table refers to record rowids.
                        database.execSQL("INSERT OR REPLACE INTO records(scope,table_name,id,row_key,json,entity_key,blob_id) VALUES(?,?,?,?,?,?,?)",
                            arrayOf(scope, table, id, row.getString("key"), row.toString(), entity, blobId))
                    }
                    "delete" -> database.execSQL("DELETE FROM records WHERE scope=? AND table_name=? AND id=?",
                        arrayOf(scope, table, identity(string(mutation, "id"))))
                    "clear" -> database.execSQL("DELETE FROM records WHERE scope=? AND table_name=?", arrayOf(scope, table))
                }
            }
            changed.forEach { table ->
                val previous = revision(scope, table)
                valid(previous < Long.MAX_VALUE, "Library revision capacity exceeded.")
                database.execSQL("INSERT OR REPLACE INTO revisions(scope,table_name,revision) VALUES(?,?,?)", arrayOf<Any>(scope, table, previous + 1))
            }
            JSONObject().put("committed", true)
        }
    }

    @Synchronized fun beginBlob(request: JSONObject, epoch: String): JSONObject {
        fields(request, setOf("scope", "size", "mime", "name"))
        val scope = scope(string(request, "scope")); val size = integer(request, "size", MAX_FILE)
        val mime = string(request, "mime"); val name = string(request, "name")
        valid(epoch.isNotEmpty() && utf8(mime) <= 1024 && mime.none(Char::isISOControl) &&
            utf8(name) <= 4096 && name.isNotEmpty() && name.none(Char::isISOControl), "Invalid native file metadata.")
        cleanup()
        return transaction {
            database.rawQuery("SELECT COUNT(*),COALESCE(SUM(state=0),0),COALESCE(SUM(size),0) FROM blobs", null).use { cursor ->
                check(cursor.moveToFirst())
                valid(cursor.getLong(0) < 4096 && cursor.getLong(1) < 4 && cursor.getLong(2) <= MAX_TOTAL - size,
                    "Native file storage has reached its capacity.")
            }
            val id = UUID.randomUUID().toString(); val part = file(id, false)
            check(part.createNewFile()); Os.chmod(part.absolutePath, 0x180)
            try {
                FileOutputStream(part, true).use { it.fd.sync() }; syncDirectory(files)
                database.execSQL("INSERT INTO blobs(id,scope,size,mime,name,state,offset,created_at,process_id,epoch) VALUES(?,?,?,?,?,0,0,?,?,?)",
                    arrayOf<Any>(id, scope, size, mime, name, now(), processId, epoch))
                JSONObject().put("id", id)
            } catch (error: Exception) { part.delete(); throw error }
        }
    }

    @Synchronized fun appendBlob(request: JSONObject, epoch: String): JSONObject {
        fields(request, setOf("scope", "id", "offset", "dataBase64"))
        val scope = scope(string(request, "scope")); val id = handle(string(request, "id"))
        val offset = integer(request, "offset", MAX_FILE); val encoded = string(request, "dataBase64")
        valid(encoded.length in 1..((MAX_CHUNK + 2) / 3 * 4) && encoded.matches(BASE64), "Invalid native file chunk encoding or size.")
        val bytes = try { Base64.decode(encoded, Base64.NO_WRAP) } catch (_: IllegalArgumentException) { throw LibraryStorageException("Invalid native file chunk encoding.") }
        valid(bytes.isNotEmpty() && bytes.size <= MAX_CHUNK && Base64.encodeToString(bytes, Base64.NO_WRAP) == encoded,
            "Native file chunks must contain 1 to 256 KiB in canonical base64.")
        return transaction {
            val record = blob(scope, id); pending(record, epoch)
            valid(offset == record.offset && bytes.size.toLong() <= record.size - offset, "Native file chunks must be appended at the exact next offset.")
            val part = file(id, false); requireFile(part, record.offset)
            RandomAccessFile(part, "rw").use { output -> output.seek(offset); output.write(bytes); output.fd.sync() }
            database.execSQL("UPDATE blobs SET offset=?,created_at=? WHERE id=?", arrayOf<Any>(offset + bytes.size, now(), id))
            JSONObject()
        }
    }

    @Synchronized fun finishBlob(request: JSONObject, epoch: String): JSONObject {
        val (scope, id) = requestedHandle(request)
        return transaction {
            val record = blob(scope, id)
            if (record.state == 1 && record.process == processId && record.epoch == epoch) {
                requireFile(file(id, true), record.size); return@transaction record.reference()
            }
            pending(record, epoch)
            valid(record.offset == record.size, "The native file transfer is incomplete.")
            val part = file(id, false); val finished = file(id, true)
            requireFile(part, record.size); valid(!regularOptional(finished), "The native file destination already exists.")
            FileOutputStream(part, true).use { it.fd.sync() }
            check(part.renameTo(finished)); syncDirectory(files)
            database.execSQL("UPDATE blobs SET state=1,created_at=? WHERE id=?", arrayOf<Any>(now(), id))
            record.reference()
        }
    }

    @Synchronized fun readBlob(request: JSONObject): JSONObject {
        fields(request, setOf("scope", "blobId", "offset", "length"))
        val scope = scope(string(request, "scope")); val id = handle(string(request, "blobId"))
        val offset = integer(request, "offset", MAX_FILE); val requested = integer(request, "length", MAX_CHUNK.toLong())
        valid(requested > 0, "Native file reads require 1 to 256 KiB.")
        return transaction {
            val record = blob(scope, id)
            valid(record.state == 1 && offset <= record.size, "Invalid native file receipt or read offset.")
            val source = file(id, true); requireFile(source, record.size)
            val count = minOf(requested, record.size - offset).toInt(); val bytes = ByteArray(count)
            RandomAccessFile(source, "r").use { input -> input.seek(offset); input.readFully(bytes) }
            database.execSQL("UPDATE blobs SET created_at=? WHERE id=?", arrayOf<Any>(now(), id))
            JSONObject().put("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP)).put("done", offset + count == record.size)
        }
    }

    @Synchronized fun cancelBlob(request: JSONObject): JSONObject {
        val (scope, id) = requestedHandle(request)
        val removed = transaction { database.delete("blobs", "scope=? AND id=? AND state=0", arrayOf(scope, id)) }
        if (removed > 0) { listOf(false, true).forEach { removeFile(file(id, it)) }; syncDirectory(files) }
        return JSONObject()
    }
    @Synchronized override fun close() { database.close() }

    private data class Blob(val id: String, val size: Long, val mime: String, val name: String, val state: Int,
        val offset: Long, val created: Long, val process: String, val epoch: String) {
        fun reference() = JSONObject().put("blobId", id).put("size", size).put("mime", mime).put("name", name)
    }
    private fun blob(scope: String, id: String): Blob = database.rawQuery(
        "SELECT size,mime,name,state,offset,created_at,process_id,epoch FROM blobs WHERE scope=? AND id=?", arrayOf(scope, id)).use { cursor ->
        valid(cursor.moveToFirst(), "The native file receipt does not belong to this library.")
        Blob(id, cursor.getLong(0), cursor.getString(1), cursor.getString(2), cursor.getInt(3), cursor.getLong(4), cursor.getLong(5), cursor.getString(6), cursor.getString(7))
    }
    private fun pending(blob: Blob, epoch: String) {
        valid(blob.state == 0 && blob.process == processId && blob.epoch == epoch && now() - blob.created <= STAGING_TTL,
            "This native file transfer expired or belongs to an earlier connection.")
    }
    private fun validateReference(scope: String, row: JSONObject): String {
        val value = objectValue(row, "value"); fields(value, setOf("name", "blob"))
        val reference = objectValue(value, "blob"); fields(reference, setOf("blobId", "size", "mime", "name"))
        val id = handle(string(reference, "blobId")); val record = blob(scope, id)
        valid(record.state == 1 && integer(reference, "size", MAX_FILE) == record.size &&
            string(reference, "mime") == record.mime && string(reference, "name") == record.name && string(value, "name") == record.name,
            "Native file metadata does not match its immutable receipt.")
        requireFile(file(id, true), record.size); return id
    }
    private fun cleanup() {
        val expired = transaction {
            val ids = mutableListOf<String>()
            database.rawQuery("SELECT id FROM blobs WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM records WHERE records.blob_id=blobs.id)",
                arrayOf((now() - STAGING_TTL).toString())).use { cursor -> while (cursor.moveToNext()) ids.add(cursor.getString(0)) }
            ids.forEach { database.execSQL("DELETE FROM blobs WHERE id=?", arrayOf(it)) }; ids
        }
        expired.forEach { id -> listOf(false, true).forEach { removeFile(file(id, it)) } }
        files.listFiles()?.forEach { path ->
            if (path.extension !in setOf("part", "bin") || !ID.matches(path.nameWithoutExtension)) return@forEach
            regularOptional(path)
            if (now() - path.lastModified() < STAGING_TTL) return@forEach
            val exists = scalar("SELECT EXISTS(SELECT 1 FROM blobs WHERE id=?)", arrayOf(path.nameWithoutExtension)) == "1"
            if (!exists) removeFile(path)
        }
    }
    private fun requestedHandle(request: JSONObject): Pair<String, String> {
        fields(request, setOf("scope", "id")); return scope(string(request, "scope")) to handle(string(request, "id"))
    }
    private fun file(id: String, finished: Boolean) = File(files, "$id.${if (finished) "bin" else "part"}")
    private fun revision(scope: String, table: String): Long = scalar(
        "SELECT COALESCE((SELECT revision FROM revisions WHERE scope=? AND table_name=?),0)", arrayOf(scope, table)).toLong()
    private fun scalar(sql: String, arguments: Array<String> = emptyArray()): String = database.compileStatement(sql).use { statement ->
        arguments.forEachIndexed { index, value -> statement.bindString(index + 1, value) }; statement.simpleQueryForString()
    }
    private inline fun <T> transaction(action: () -> T): T {
        // Android maps this to BEGIN IMMEDIATE; setTransactionSuccessful commits only after all checks.
        database.beginTransactionNonExclusive()
        try { return action().also { database.setTransactionSuccessful() } } finally { database.endTransaction() }
    }

    companion object {
        const val MAX_CHUNK = 256 * 1024
        const val MAX_FILE = 4L * 1024 * 1024 * 1024
        const val MAX_TOTAL = 8L * 1024 * 1024 * 1024
        const val STAGING_TTL = 60 * 60 * 1000L
        private const val MAX_ROW_BYTES = 8 * 1024 * 1024
        private const val MAX_BATCH_BYTES = 64L * 1024 * 1024
        private const val MAX_ROWS = 100000
        private val TABLES = setOf("books", "anchors", "annotations", "collections", "sessions", "preferences", "outbox", "localFiles", "nativeReceipts")
        private val ID = Regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
        private val BASE64 = Regex("[A-Za-z0-9+/]+={0,2}")
        private fun valid(value: Boolean, message: String) { if (!value) throw LibraryStorageException(message) }
        private fun utf8(value: String) = value.toByteArray(Charsets.UTF_8).size
        private fun strictString(value: Any?): String { valid(value is String, "A string is required."); return value as String }
        private fun strictObject(value: Any?): JSONObject { valid(value is JSONObject, "A JSON object is required."); return value as JSONObject }
        private fun string(value: JSONObject, name: String) = strictString(value.opt(name))
        private fun objectValue(value: JSONObject, name: String) = strictObject(value.opt(name))
        private fun arrayValue(value: JSONObject, name: String): JSONArray { val array = value.opt(name); valid(array is JSONArray, "A JSON array is required."); return array as JSONArray }
        private fun boolean(value: JSONObject, name: String): Boolean { val boolean = value.opt(name); valid(boolean is Boolean, "A boolean is required."); return boolean as Boolean }
        private fun integer(value: JSONObject, name: String, maximum: Long): Long {
            val raw = value.opt(name); valid(raw is Number, "An integer is required.")
            val number = (raw as Number).toDouble()
            valid(number.isFinite() && number % 1 == 0.0 && number >= 0 && number <= maximum.toDouble(), "The native file size or offset is invalid.")
            return number.toLong()
        }
        private fun fields(value: JSONObject, required: Set<String>, optional: Set<String> = emptySet()) {
            valid(required.all { value.has(it) && !value.isNull(it) } && value.keys().asSequence().all { it in required || it in optional }, "Invalid native library request fields.")
        }
        private fun table(value: String): String { valid(value in TABLES, "Invalid library table."); return value }
        private fun identity(value: String): String { valid(value.isNotBlank() && utf8(value) <= 8192 && value.none(Char::isISOControl), "Invalid library row identity."); return value }
        internal fun canonicalArray(values: List<String>) = values.joinToString(",", "[", "]", transform = ::quote)
        private fun quote(value: String): String = buildString {
            append('"'); var index = 0
            while (index < value.length) {
                val char = value[index]
                when (char) {
                    '"' -> append("\\\""); '\\' -> append("\\\\"); '\b' -> append("\\b"); '\t' -> append("\\t")
                    '\n' -> append("\\n"); '\u000c' -> append("\\f"); '\r' -> append("\\r")
                    else -> when {
                        char < ' ' -> append("\\u%04x".format(char.code))
                        char.isHighSurrogate() && index + 1 < value.length && value[index + 1].isLowSurrogate() -> { append(char); append(value[++index]) }
                        char.isSurrogate() -> append("\\u%04x".format(char.code))
                        else -> append(char)
                    }
                }
                index++
            }
            append('"')
        }
        private fun scope(value: String): String {
            valid(utf8(value) <= 32768, "Invalid library account scope.")
            val array = try { JSONArray(value) } catch (_: Exception) { throw LibraryStorageException("Invalid library account scope.") }
            valid(array.length() == 2, "Invalid library account scope.")
            val server = strictString(array.get(0)); val user = identity(strictString(array.get(1)))
            val uri = try { URI(server) } catch (_: Exception) { throw LibraryStorageException("Invalid library account scope.") }
            val encodedDotSegment = uri.rawPath.orEmpty().split('/').any {
                it.replace(Regex("(?i)%2e"), ".") in setOf(".", "..")
            }
            valid(server.length <= 8192 && uri.scheme in setOf("http", "https") && !uri.host.isNullOrEmpty() &&
                uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null && uri.scheme == uri.scheme.lowercase() &&
                uri.host == uri.host.lowercase() && uri.port != (if (uri.scheme == "https") 443 else 80) &&
                server == server.trimEnd('/').removeSuffix("/api/v1") && uri.normalize() == uri &&
                uri.toASCIIString() == server && !encodedDotSegment &&
                value == canonicalArray(listOf(server, user)), "Invalid library account scope.")
            return value
        }
        private fun rowIdentity(scope: String, row: JSONObject): String {
            val id = identity(string(row, "id"))
            valid(string(row, "scope") == scope && string(row, "key") == canonicalArray(listOf(scope, id)), "Library rows must match their scoped identity.")
            return id
        }
        private fun parseRevision(value: String): Long {
            val number = value.toLongOrNull(); valid(number != null && number >= 0 && number.toString() == value, "Invalid library revision."); return number!!
        }
        private fun handle(value: String): String { valid(ID.matches(value), "Invalid native file handle."); return value }
        private fun privateDirectory(path: File) {
            check(path.mkdirs() || path.isDirectory)
            check(OsConstants.S_ISDIR(Os.lstat(path.absolutePath).st_mode)); Os.chmod(path.absolutePath, 0x1c0)
        }
        private fun regularOptional(path: File): Boolean = try {
            check(OsConstants.S_ISREG(Os.lstat(path.absolutePath).st_mode)); Os.chmod(path.absolutePath, 0x180); true
        } catch (error: ErrnoException) { if (error.errno == OsConstants.ENOENT) false else throw error }
        private fun requireFile(path: File, size: Long) { valid(regularOptional(path) && path.length() == size, "The native file is missing or incomplete.") }
        private fun removeFile(path: File) { if (regularOptional(path)) check(path.delete()) }
        private fun syncDirectory(path: File) {
            // O_DIRECTORY is not exposed by Android's public OsConstants API. The private parent
            // directory was checked with lstat, and opening it read-only supports directory fsync.
            val descriptor = Os.open(path.absolutePath, OsConstants.O_RDONLY, 0)
            try { Os.fsync(descriptor) } finally { Os.close(descriptor) }
        }
    }
}

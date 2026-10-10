package app.avid.playback

import android.database.sqlite.SQLiteDatabase
import android.system.Os
import android.system.OsConstants
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files

/** Real Android SQLite through Robolectric's AOSP native SQLite runtime, never a fake store. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE, shadows = [LibraryFileOs::class])
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class LibraryStorageStoreTest {
    private lateinit var root: File
    private lateinit var store: LibraryStorageStore
    private var now = 1_000_000_000L
    private val a = scope("a")
    private val b = scope("b")
    @Before fun setup() {
        root = Files.createTempDirectory("avid-library-sqlite-test-").toFile()
        store = LibraryStorageStore(root) { now }
    }
    @After fun cleanup() { if (::store.isInitialized) store.close(); if (::root.isInitialized) root.deleteRecursively() }
    private fun obj(vararg values: Pair<String, Any?>) = JSONObject().apply { values.forEach { (key, value) -> put(key, value) } }
    private fun row(scope: String, id: String, value: Any) = obj("scope" to scope, "id" to id,
        "key" to LibraryStorageStore.canonicalArray(listOf(scope, id)), "value" to value)
    private fun put(scope: String, table: String, id: String, value: Any) = obj("type" to "put", "table" to table, "row" to row(scope, id, value))
    private fun read(scope: String = a, table: String = "books", query: JSONObject = JSONObject()) = store.read(obj("scope" to scope, "table" to table, "query" to query))
    private fun commit(scope: String = a, expected: JSONObject = obj("books" to "0"), vararg mutations: JSONObject) = store.commit(obj("scope" to scope, "expected" to expected, "mutations" to JSONArray(mutations.toList())))
    private fun begin(scope: String = a, size: Long = 0, epoch: String = "epoch-1") = store.beginBlob(obj("scope" to scope, "size" to size, "mime" to "audio/mpeg", "name" to "book.mp3"), epoch).getString("id")
    private fun append(id: String, offset: Long, bytes: ByteArray, scope: String = a, epoch: String = "epoch-1") = store.appendBlob(obj("scope" to scope, "id" to id, "offset" to offset, "dataBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP)), epoch)
    private fun finish(id: String, scope: String = a, epoch: String = "epoch-1") = store.finishBlob(obj("scope" to scope, "id" to id), epoch)
    private fun bytes(id: String, offset: Long, length: Int, scope: String = a) = store.readBlob(obj("scope" to scope, "blobId" to id, "offset" to offset, "length" to length))
    private fun fileRow(id: String, reference: JSONObject, scope: String = a) = put(scope, "localFiles", id, obj("name" to reference.getString("name"), "blob" to reference))
    private fun sql(action: (SQLiteDatabase) -> Unit) {
        SQLiteDatabase.openDatabase(File(root, "library.sqlite3").absolutePath, null, SQLiteDatabase.OPEN_READWRITE).use(action)
    }
    private fun scalar(db: SQLiteDatabase, sql: String) = db.compileStatement(sql).use { it.simpleQueryForString() }
    private fun productionDatabase() = LibraryStorageStore::class.java.getDeclaredField("database").apply { isAccessible = true }.get(store) as SQLiteDatabase
    private fun fails(action: () -> Any?) { try { action(); fail("Expected an explicit storage error") } catch (expected: Exception) { assertFalse(expected.message.isNullOrEmpty()) } }

    @Test fun databaseUsesRealWalFullAndDurableSchemaMigration() {
        val db = productionDatabase()
        assertEquals("1", scalar(db, "PRAGMA user_version")); assertEquals("wal", scalar(db, "PRAGMA journal_mode")); assertEquals("2", scalar(db, "PRAGMA synchronous")); assertNotEquals(":memory:", db.path)
        assertTrue(commit(mutations = arrayOf(put(a, "books", "book", "durable"))).getBoolean("committed"))
        store.close(); store = LibraryStorageStore(root) { now }
        assertEquals("durable", read().getJSONArray("rows").getJSONObject(0).getString("value"))
        store.close(); sql { it.execSQL("PRAGMA user_version=2") }
        fails { LibraryStorageStore(root) }
    }
    @Test fun compareAllRevisionsAndEmptyTransactionsWithoutPartialWrites() {
        commit(mutations = arrayOf(put(a, "books", "book", 1)))
        val result = commit(expected = obj("books" to "0", "anchors" to "0"), mutations = arrayOf(put(a, "anchors", "book", 2)))
        assertFalse(result.getBoolean("committed")); assertEquals(0, read(table = "anchors").getJSONArray("rows").length())
        assertFalse(commit(expected = obj("books" to "0")).getBoolean("committed"))
        assertTrue(commit(expected = obj("books" to "1", "anchors" to "0")).getBoolean("committed"))
        fails { commit(expected = JSONObject(), mutations = arrayOf(put(a, "books", "new", 1))) }
        assertEquals("1", read().getString("revision"))
    }
    @Test fun orderedMutationsAndClearKeepMonotonicRevisionsAndScopes() {
        commit(mutations = arrayOf(put(a, "books", "shared", "a")))
        commit(scope = b, mutations = arrayOf(put(b, "books", "shared", "b")))
        commit(expected = obj("books" to "1"), mutations = arrayOf(obj("type" to "delete", "table" to "books", "id" to "shared"), put(a, "books", "shared", "replaced")))
        assertEquals("replaced", read().getJSONArray("rows").getJSONObject(0).getString("value"))
        for (revision in 2..3) commit(expected = obj("books" to revision.toString()), mutations = arrayOf(obj("type" to "clear", "table" to "books")))
        store.close(); store = LibraryStorageStore(root) { now }
        assertEquals("4", read().getString("revision")); assertEquals(0, read().getJSONArray("rows").length())
        assertEquals("b", read(scope = b).getJSONArray("rows").getJSONObject(0).getString("value"))
    }
    @Test fun malformedSecondRowAndSqlTriggerFailureRollBackEverything() {
        val forged = put(a, "books", "second", 2).apply { getJSONObject("row").put("scope", b) }
        fails { commit(mutations = arrayOf(put(a, "books", "first", 1), forged)) }
        assertEquals("0", read().getString("revision")); assertEquals(0, read().getJSONArray("rows").length())
        sql { it.execSQL("CREATE TRIGGER injected BEFORE INSERT ON records WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'injected'); END") }
        fails { commit(mutations = arrayOf(put(a, "books", "first", 1), put(a, "books", "second", 2))) }
        assertEquals("0", read().getString("revision")); assertEquals(0, read().getJSONArray("rows").length())
    }
    @Test fun outboxUsesIdKeyAndEntityFilterIntersectsIdsAlongsideSessionReceipts() {
        val first = put(a, "outbox", "operation-1", 1).apply { getJSONObject("row").put("entityKey", "book") }
        val second = put(a, "outbox", "operation-2", 2).apply { getJSONObject("row").put("entityKey", "other") }
        commit(expected = obj("outbox" to "0", "sessions" to "0", "nativeReceipts" to "0"), mutations = arrayOf(first, second,
            put(a, "sessions", "session", obj("duration" to 15)), put(a, "nativeReceipts", "receipt", "fingerprint")))
        val rows = read(table = "outbox", query = obj("ids" to JSONArray(listOf("operation-1", "operation-2")), "entityKey" to "book", "keysOnly" to true)).getJSONArray("rows")
        assertEquals(1, rows.length()); assertEquals("operation-1", rows.getJSONObject(0).getString("id")); assertFalse(rows.getJSONObject(0).has("value"))
        assertEquals(LibraryStorageStore.canonicalArray(listOf(a, "operation-1")), rows.getJSONObject(0).getString("key"))
        val empty = read(table = "outbox", query = obj("ids" to JSONArray())); assertEquals(0, empty.getJSONArray("rows").length()); assertEquals("1", empty.getString("revision"))
        assertEquals(1, read(table = "sessions").getJSONArray("rows").length()); assertEquals(1, read(table = "nativeReceipts").getJSONArray("rows").length())
    }
    @Test fun twoActualDatabaseConnectionsCannotCommitSameRevision() {
        LibraryStorageStore(root) { now }.use { second ->
            assertEquals("0", second.read(obj("scope" to a, "table" to "books")).getString("revision"))
            assertTrue(commit(mutations = arrayOf(put(a, "books", "book", "first"))).getBoolean("committed"))
            val stale = second.commit(obj("scope" to a, "expected" to obj("books" to "0"), "mutations" to JSONArray().put(put(a, "books", "book", "stale"))))
            assertFalse(stale.getBoolean("committed")); assertEquals("first", read().getJSONArray("rows").getJSONObject(0).getString("value"))
        }
    }
    @Test fun jsonRecordsLargerThanCursorWindowRemainReadable() {
        val text = "x".repeat(3 * 1024 * 1024)
        commit(mutations = arrayOf(put(a, "books", "large-description", text)))
        assertEquals(text.length, read().getJSONArray("rows").getJSONObject(0).getString("value").length)
        assertFalse(read(query = obj("keysOnly" to true)).getJSONArray("rows").getJSONObject(0).has("value"))
    }
    @Test fun idsBeyondOldAndroidParameterLimitAreBatchedInOneRevision() {
        val ids = (0 until 1001).map { "book-${it.toString().padStart(4, '0')}" }
        commit(mutations = ids.map { put(a, "books", it, it) }.toTypedArray())
        val requested = JSONArray(ids + ids.take(3) + "absent")
        val result = read(query = obj("ids" to requested, "keysOnly" to true))
        assertEquals("1", result.getString("revision")); assertEquals(ids.size, result.getJSONArray("rows").length())
        assertEquals(ids.toSet(), (0 until ids.size).map { result.getJSONArray("rows").getJSONObject(it).getString("id") }.toSet())
    }
    @Test fun scopedOrderedChunksAndExactReadsWorkBeforePublicationAndAfterReopen() {
        val id = begin(size = 6)
        fails { append(id, 1, "abc".toByteArray()) }; fails { append(id, 0, "abc".toByteArray(), scope = b) }
        append(id, 0, "abc".toByteArray()); fails { finish(id) }; fails { append(id, 0, "abc".toByteArray()) }
        append(id, 3, "def".toByteArray()); val reference = finish(id)
        assertEquals(reference.toString(), finish(id).toString()); fails { append(id, 6, byteArrayOf(1)) }
        val first = bytes(id, 0, 2); assertArrayEquals("ab".toByteArray(), Base64.decode(first.getString("dataBase64"), Base64.DEFAULT)); assertFalse(first.getBoolean("done"))
        val end = bytes(id, 2, LibraryStorageStore.MAX_CHUNK); assertArrayEquals("cdef".toByteArray(), Base64.decode(end.getString("dataBase64"), Base64.DEFAULT)); assertTrue(end.getBoolean("done"))
        assertEquals("", bytes(id, 6, 1).getString("dataBase64")); fails { bytes(id, 0, 1, scope = b) }
        commit(expected = obj("localFiles" to "0"), mutations = arrayOf(fileRow("file", reference)))
        store.close(); store = LibraryStorageStore(root) { now }
        assertEquals("abcdef", String(Base64.decode(bytes(id, 0, 6).getString("dataBase64"), Base64.DEFAULT)))
    }
    @Test fun zeroByteFilesAndForgedReceiptsCannotPartiallyCommit() {
        val id = begin(); val reference = finish(id); val forged = JSONObject(reference.toString()).put("size", 1)
        fails { commit(expected = obj("books" to "0", "localFiles" to "0"), mutations = arrayOf(put(a, "books", "book", 1), fileRow("file", forged))) }
        assertEquals(0, read().getJSONArray("rows").length())
        fails { commit(scope = b, expected = obj("localFiles" to "0"), mutations = arrayOf(fileRow("file", reference, b))) }
        commit(expected = obj("localFiles" to "0"), mutations = arrayOf(fileRow("file", reference)))
        store.cancelBlob(obj("scope" to a, "id" to id)); val path = File(root, "blobs/$id.bin"); assertTrue(path.exists())
        path.delete(); assertEquals(1, read(table = "localFiles", query = obj("keysOnly" to true)).getJSONArray("rows").length()); fails { bytes(id, 0, 1) }
    }
    @Test fun newConnectionEpochAndProcessRestartRejectPendingHandles() {
        val id = begin(size = 1)
        fails { append(id, 0, byteArrayOf(1), epoch = "next-connection") }; append(id, 0, byteArrayOf(1))
        fails { finish(id, epoch = "next-connection") }
        store.close(); store = LibraryStorageStore(root) { now }; fails { finish(id) }
        store.cancelBlob(obj("scope" to a, "id" to id)); assertFalse(File(root, "blobs/$id.part").exists())
    }
    @Test fun sparseFourGibibyteReceiptKeepsOffsetsAndReadsBounded() {
        val id = begin(size = LibraryStorageStore.MAX_FILE)
        RandomAccessFile(File(root, "blobs/$id.part"), "rw").use { it.setLength(LibraryStorageStore.MAX_FILE) }
        sql { it.execSQL("UPDATE blobs SET offset=? WHERE id=?", arrayOf(LibraryStorageStore.MAX_FILE, id)) }
        assertEquals(LibraryStorageStore.MAX_FILE, finish(id).getLong("size"))
        assertEquals(1, Base64.decode(bytes(id, 0, 1).getString("dataBase64"), Base64.DEFAULT).size)
        val end = bytes(id, LibraryStorageStore.MAX_FILE - 2, LibraryStorageStore.MAX_CHUNK)
        assertArrayEquals(byteArrayOf(0, 0), Base64.decode(end.getString("dataBase64"), Base64.DEFAULT)); assertTrue(end.getBoolean("done"))
    }
    @Test fun expiredUnreferencedStagingFreesSlotsButPublishedFilesSurvive() {
        val published = begin(); val reference = finish(published)
        commit(expected = obj("localFiles" to "0"), mutations = arrayOf(fileRow("file", reference)))
        val unused = begin(); finish(unused); repeat(4) { begin() }; fails { begin() }
        now += LibraryStorageStore.STAGING_TTL + 1
        val fresh = begin(); assertTrue(File(root, "blobs/$fresh.part").exists()); assertTrue(File(root, "blobs/$published.bin").exists()); assertFalse(File(root, "blobs/$unused.bin").exists())
    }
    @Test fun activeAppendExtendsIdleExpiryAndQuotaIsBounded() {
        val id = begin(size = 2)
        now += LibraryStorageStore.STAGING_TTL - 1; append(id, 0, byteArrayOf(1))
        now += LibraryStorageStore.STAGING_TTL - 1; append(id, 1, byteArrayOf(2)); finish(id)
        val one = begin(size = LibraryStorageStore.MAX_FILE); fails { begin(size = LibraryStorageStore.MAX_FILE) }
        store.cancelBlob(obj("scope" to a, "id" to one))
        val pending = begin(size = LibraryStorageStore.MAX_CHUNK.toLong() + 1); fails { append(pending, 0, ByteArray(LibraryStorageStore.MAX_CHUNK + 1)) }
    }
    @Test fun canonicalScopesKeysAndStrictPrimitiveTypesRejectForgedValues() {
        val demo = "[\"https://demo.avid.invalid\",\"demo\"]"; assertEquals("0", read(scope = demo).getString("revision"))
        for (invalid in listOf("[]", "[\"file:///tmp\",\"user\"]", "[\"https://library.example/\",\"user\"]", "[ \"https://library.example\",\"user\"]", "[\"https://user:secret@library.example\",\"user\"]")) fails { read(scope = invalid) }
        fails { read(table = "arbitrary") }; fails { store.beginBlob(obj("scope" to a, "size" to "0", "mime" to "", "name" to "file"), "epoch") }
        fails { store.read(obj("scope" to a, "table" to "books", "query" to obj("keysOnly" to "true"))) }
        assertEquals("[\"slash/and\\\"quote\",\"line\u2028separator\",\"emoji😀\"]", LibraryStorageStore.canonicalArray(listOf("slash/and\"quote", "line\u2028separator", "emoji😀")))
        val forged = put(a, "books", "book", 1).apply { getJSONObject("row").put("key", "book") }; fails { commit(mutations = arrayOf(forged)) }
    }
    @Test fun filesArePrivateAndSymlinkReceiptsAreRejected() {
        val id = begin(); val path = File(root, "blobs/$id.part")
        assertEquals(0x1c0, Os.stat(root.absolutePath).st_mode and 0x1ff)
        assertEquals(0x180, Os.stat(File(root, "library.sqlite3").absolutePath).st_mode and 0x1ff)
        assertEquals(0x180, Os.stat(path.absolutePath).st_mode and 0x1ff)
        path.delete(); Files.createSymbolicLink(path.toPath(), File(root, "library.sqlite3").toPath())
        assertTrue(OsConstants.S_ISLNK(Os.lstat(path.absolutePath).st_mode)); fails { finish(id) }
    }
    companion object { private fun scope(user: String) = LibraryStorageStore.canonicalArray(listOf("https://library.example", user)) }
}

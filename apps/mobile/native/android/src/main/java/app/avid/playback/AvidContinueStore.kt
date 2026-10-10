package app.avid.playback

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Widget metadata only. No URLs, credentials, locators or book contents enter this encrypted record. */
internal object AvidContinueStore {
    private const val KEY = "app.avid.reader.continue-reading"
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "avid-continue-reading.bin"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
        }.generateKey()
    }
    private fun read(context: Context): JSONObject {
        val file = file(context)
        if (!file.baseFile.exists()) return JSONObject()
        val bytes = file.readFully()
        require(bytes.size in 29..8_388_608) { "The Continue Reading record is invalid." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
    private fun write(context: Context, record: JSONObject) {
        val plain = record.toString().toByteArray(Charsets.UTF_8)
        require(plain.size <= 8_388_580) { "The Continue Reading catalog is full." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.iv + cipher.doFinal(plain)
        val file = file(context); val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    private fun books(record: JSONObject): List<JSONObject> = record.optJSONArray("books")?.let { values ->
        (0 until values.length()).map { values.getJSONObject(it) }
    } ?: emptyList()
    private fun activeAccount(context: Context): String? {
        val session = AvidSessionStore.read(context).optJSONObject("session") ?: return null
        val server = session.getJSONObject("profile").getString("url").trimEnd('/').removeSuffix("/api/v1")
        return ContinueIdentity.account(server, session.getString("userId"))
    }
    private fun scopeIdentity(scope: String): Pair<String, String> {
        require(scope.length in 1..8192)
        val identity = JSONArray(scope)
        require(identity.length() == 2 && identity.get(0) is String && identity.get(1) is String)
        val server = identity.getString(0); val user = identity.getString(1)
        require(server.isNotBlank() && user.isNotBlank())
        return ContinueIdentity.hash(scope) to ContinueIdentity.account(server, user)
    }
    private fun scoped(context: Context, scope: String): JSONObject {
        val (hash, account) = scopeIdentity(scope)
        val record = read(context)
        require(record.optString("scopeHash") == hash && record.optString("accountHash") == account) {
            "The Continue Reading catalog belongs to another account."
        }
        return record
    }
    private fun lookup(context: Context, record: JSONObject, id: String): JSONObject? {
        val book = books(record).firstOrNull { it.optString("id") == id } ?: return null
        return if (ContinueIdentity.permits(activeAccount(context), record.optString("accountHash"), record.optString("scopeHash"),
                id, book.optString("bookId"), book.optString("fileId"), book.optString("kind"))) book else null
    }
    @Synchronized fun activate(context: Context, scope: String) {
        val (hash, account) = scopeIdentity(scope)
        // The bridge may activate while its secure session write is in flight. Rendering and navigation
        // still require an exact vault identity match, so this cannot expose another account's metadata.
        val previous = try { read(context) } catch (_: Exception) { JSONObject() }
        if (previous.optString("scopeHash") == hash && previous.optString("accountHash") == account) return
        write(context, JSONObject().put("scopeHash", hash).put("accountHash", account).put("books", JSONArray()))
    }
    @Synchronized fun clear(context: Context) { write(context, JSONObject()) }
    @Synchronized fun index(context: Context, scope: String, incoming: List<JSONObject>, recent: Boolean = false): List<String> {
        require(incoming.size <= 500)
        val record = scoped(context, scope)
        val values = books(record).associateBy { it.getString("id") }.toMutableMap()
        val ids = incoming.map { input ->
            fun text(name: String, maximum: Int, allowBlank: Boolean = false): String {
                val value = input.get(name)
                require(value is String && value.length <= maximum && (allowBlank || value.isNotBlank()))
                return value
            }
            val book = text("bookId", 1024); val file = text("fileId", 1024)
            val kind = text("kind", 8); require(kind in ContinueIdentity.kinds)
            require(input.get("progress") is Number)
            val progress = input.getDouble("progress"); require(progress.isFinite() && progress in 0.0..1.0)
            val id = ContinueIdentity.identifier(record.getString("scopeHash"), book, file)
            val previous = values[id]
            values[id] = JSONObject().put("id", id).put("bookId", book).put("fileId", file).put("kind", kind)
                .put("title", text("title", 2048)).put("author", text("author", 2048, true))
                // Bulk metadata refresh must not overwrite the newer active reader's published position.
                .put("progress", if (!recent && previous?.optLong("recentAt", 0L) != null && previous.optLong("recentAt") > 0) previous.getDouble("progress") else progress)
                .put("recentAt", if (recent) System.currentTimeMillis() else previous?.optLong("recentAt", 0L) ?: 0L)
            id
        }
        record.put("books", JSONArray(values.values.toList()))
        write(context, record)
        return ids
    }
    @Synchronized fun remove(context: Context, ids: List<String>): List<JSONObject> {
        require(ids.size <= 500)
        val record = read(context)
        require(activeAccount(context) == record.optString("accountHash")) { "The Continue Reading account changed." }
        val values = books(record)
        require(ids.all { id -> values.any { it.getString("id") == id } }) { "Unknown Continue Reading identity." }
        val removed = values.filter { it.getString("id") in ids }
        record.put("books", JSONArray(values.filter { it.getString("id") !in ids }))
        if (record.optString("pendingId") in ids) record.remove("pendingId")
        write(context, record)
        return removed
    }
    @Synchronized fun recent(context: Context): JSONObject? {
        val record = read(context)
        val book = books(record).filter { it.optLong("recentAt") > 0 }.maxByOrNull { it.optLong("recentAt") } ?: return null
        return lookup(context, record, book.getString("id"))
    }
    @Synchronized fun recentBooks(context: Context, maximum: Int): List<JSONObject> {
        val record = read(context)
        return books(record).filter { it.optLong("recentAt") > 0 }
            .sortedByDescending { it.optLong("recentAt") }.take(maximum.coerceIn(0, 4))
            .mapNotNull { lookup(context, record, it.getString("id")) }
    }
    @Synchronized fun permitsShortcut(context: Context, id: String): Boolean = lookup(context, read(context), id) != null
    @Synchronized fun accept(context: Context, raw: String): Boolean {
        val id = ContinueIdentity.linkIdentifier(raw) ?: return false
        val record = read(context)
        if (lookup(context, record, id) == null) return false
        if (record.optString("pendingId") != id) { record.put("pendingId", id); write(context, record) }
        return true
    }
    @Synchronized fun hasNavigation(context: Context): Boolean {
        val record = read(context)
        return lookup(context, record, record.optString("pendingId")) != null
    }
    @Synchronized fun consume(context: Context): JSONObject? {
        val record = read(context)
        val book = lookup(context, record, record.optString("pendingId"))
        if (record.has("pendingId")) { record.remove("pendingId"); write(context, record) }
        return book?.let { JSONObject().put("scopeHash", record.getString("scopeHash")).put("bookId", it.getString("bookId"))
            .put("fileId", it.getString("fileId")).put("kind", it.getString("kind")) }
    }
}

package app.avid.playback

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Active-account metadata and prepared sources. Entire disk record is encrypted with an Android Keystore key. */
object AvidAudioCatalog {
    private const val KEY = "app.avid.reader.audio-catalog"
    private lateinit var file: AtomicFile
    private var loaded = false
    private var document = JSONObject().put("scope", "").put("books", JSONArray())
    private val observers = mutableSetOf<(Boolean) -> Unit>()
    val scope: String get() = document.optString("scope")
    var accountGeneration: Long = 0
        private set
    private fun books(): List<JSONObject> = document.optJSONArray("books").let { array ->
        if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
    }
    fun initialize(context: Context) {
        if (loaded) return
        loaded = true
        file = AtomicFile(File(context.noBackupFilesDir, "avid-audio-catalog.bin"))
        if (!file.baseFile.exists()) return
        try {
            val bytes = file.readFully()
            require(bytes.size > 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            document = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        } catch (_: Exception) {
            // Changed/invalidated key or corrupt recovery file: expose no stale account or guessed source.
            file.delete()
            document = JSONObject().put("scope", "").put("books", JSONArray())
        }
    }
    fun observe(callback: (Boolean) -> Unit): () -> Unit { observers.add(callback); return { observers.remove(callback) } }
    fun refreshLabels() { observers.toList().forEach { it(false) } }
    fun activate(accountScope: String) {
        require(accountScope.isNotBlank())
        if (scope == accountScope) return
        accountGeneration++
        document = JSONObject().put("scope", accountScope).put("books", JSONArray())
        observers.toList().forEach { it(true) }
        file.delete()
        persist()
    }
    fun clear() {
        accountGeneration++
        document = JSONObject().put("scope", "").put("books", JSONArray())
        file.delete(); observers.toList().forEach { it(true) }
    }
    fun index(accountScope: String, incoming: List<JSONObject>): List<String> {
        require(accountScope == scope && scope.isNotBlank()) { "The catalog belongs to a different account." }
        require(incoming.size <= 500) { "Index at most 500 books per batch." }
        val values = books().associateBy { it.getString("id") }.toMutableMap()
        val ids = incoming.map { value ->
            val book = value.optString("bookId"); val source = value.optString("fileId")
            require(book.isNotBlank() && source.isNotBlank())
            val key = id(scope, book, source)
            if (value.optString("kind") == "audio") {
                val prior = values[key] ?: JSONObject().put("id", key).put("bookId", book).put("fileId", source)
                prior.put("title", value.optString("title")).put("author", value.optString("author"))
                // Browsing metadata cannot overwrite the native owner's newer source position.
                if (!prior.has("position")) prior.put("position", value.optDouble("audioPosition", 0.0).coerceAtLeast(0.0))
                values[key] = prior
            }
            key
        }
        document.put("books", JSONArray(values.values.toList()))
        persist(); observers.toList().forEach { it(false) }; return ids
    }
    fun prepare(accountScope: String, bookId: String, fileId: String, url: String, title: String, author: String, position: Double, rate: Double, tracks: JSONArray? = null, manifestRevision: String? = null, readOnly: Boolean = true, chapters: JSONArray? = null) {
        activate(accountScope)
        val key = id(scope, bookId, fileId)
        val values = books().filter { it.optString("id") != key }.toMutableList()
        values.add(JSONObject().put("id", key).put("bookId", bookId).put("fileId", fileId).put("title", title).put("author", author)
            .put("readOnly", readOnly).put("url", url).put("tracks", tracks).put("chapters", chapters).put("manifestRevision", manifestRevision).put("position", position).put("rate", rate).put("updatedAt", System.currentTimeMillis()))
        document.put("books", JSONArray(values)); persist(); observers.toList().forEach { it(false) }
    }
    fun checkpoint(accountScope: String, bookId: String, fileId: String, position: Double, rate: Double) {
        if (scope != accountScope) return
        val entry = get(id(scope, bookId, fileId)) ?: return
        entry.put("position", position).put("rate", rate).put("updatedAt", System.currentTimeMillis())
        persist()
    }
    fun remove(ids: List<String>) {
        val allowed = books().map { it.getString("id") }.toSet()
        require(ids.all { it in allowed }) { "Unknown or different-account catalog identity." }
        document.put("books", JSONArray(books().filter { it.getString("id") !in ids }))
        persist(); observers.toList().forEach { it(false) }
    }
    fun get(id: String): JSONObject? = books().firstOrNull { it.optString("id") == id }
    fun playable(query: String? = null, recent: Boolean = false): List<JSONObject> {
        if (scope.isBlank()) return emptyList()
        val candidates = books().filter { it.optString("url").isNotBlank() &&
            (query == null || "${it.optString("title")} ${it.optString("author")}".contains(query, ignoreCase = true)) }
        return if (recent) candidates.sortedByDescending { it.optLong("updatedAt") }.take(20)
            else candidates.sortedBy { it.optString("title").lowercase() }
    }
    private fun persist() {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secret())
        val bytes = cipher.iv + cipher.doFinal(document.toString().toByteArray(Charsets.UTF_8))
        val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (error: Exception) { file.failWrite(stream); throw error }
    }
    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256).build())
        }.generateKey()
    }
    fun id(scope: String, bookId: String, fileId: String): String {
        val hash = MessageDigest.getInstance("SHA-256").digest(scope.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        return Base64.encodeToString(JSONArray(listOf(hash, bookId, fileId)).toString().toByteArray(Charsets.UTF_8), Base64.NO_WRAP)
    }
}

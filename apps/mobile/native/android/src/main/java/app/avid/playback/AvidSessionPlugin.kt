package app.avid.playback

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Serialized native vault. Even clearing writes a new generation so late refreshes cannot undo logout. */
object AvidSessionStore {
    private const val KEY = "app.avid.reader.session"
    private var cached: JSONObject? = null
    private var storageEpoch = UUID.randomUUID().toString()
    /** Atomic file chunks share this monitor with account adoption/logout, not token lifetime. */
    @Synchronized fun <T> withStorageEpoch(action: (String) -> T): T = action(storageEpoch)
    private fun scope(record: JSONObject): String? = record.optJSONObject("session")?.let { session ->
        org.json.JSONArray(listOf(AuthPolicy.server(session.getJSONObject("profile").getString("url")), session.getString("userId"))).toString()
    }
    @Synchronized fun read(context: Context): JSONObject {
        cached?.let { return it }
        val file = file(context)
        if (!file.baseFile.exists()) return save(context, JSONObject().put("generation", UUID.randomUUID().toString()))
        val bytes = file.readFully()
        require(bytes.size > 28) { "The secure session record is invalid." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)).also { cached = it }
    }
    @Synchronized fun write(context: Context, expected: String, session: JSONObject, readOnly: Boolean): JSONObject {
        val previous = read(context)
        require(previous.getString("generation") == expected) { "The secure session changed. This stale operation was discarded." }
        validate(session)
        val proposed = JSONObject().put("generation", UUID.randomUUID().toString()).put("session", session).put("readOnly", readOnly)
        val changedScope = scope(previous) != scope(proposed)
        val next = save(context, proposed)
        if (changedScope) storageEpoch = UUID.randomUUID().toString()
        return next
    }
    @Synchronized fun clear(context: Context, expected: String?): JSONObject {
        if (expected != null) require(read(context).getString("generation") == expected) { "The secure session changed. This stale operation was discarded." }
        return save(context, JSONObject().put("generation", UUID.randomUUID().toString())).also { storageEpoch = UUID.randomUUID().toString() }
    }
    @Synchronized fun readOnly(context: Context, scope: String): Boolean = try {
        val record = read(context)
        val session = record.optJSONObject("session")
        val identity = org.json.JSONArray(scope)
        session == null || identity.length() != 2 || identity.optString(1) != session.optString("userId") ||
            identity.optString(0) != session.getJSONObject("profile").getString("url").trimEnd('/').removeSuffix("/api/v1") || record.optBoolean("readOnly", true)
    } catch (_: Exception) { true }
    private fun validate(session: JSONObject) {
        require(session.toString().length <= 262144)
        require(session.optString("accessToken").isNotBlank() && session.optString("userId").isNotBlank())
        val profile = session.getJSONObject("profile")
        require(profile.optString("id").isNotBlank() && profile.optString("name").isNotBlank())
        val url = URI(profile.getString("url"))
        require(url.scheme in listOf("https", "http") && !url.host.isNullOrBlank() && url.userInfo == null)
        require(session.keys().asSequence().all { it in setOf("profile", "userId", "accessToken", "refreshToken", "clientKind") })
    }
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "avid-session.bin"))
    private fun save(context: Context, value: JSONObject): JSONObject {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.iv + cipher.doFinal(value.toString().toByteArray(Charsets.UTF_8))
        val file = file(context); val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) } catch (error: Exception) { file.failWrite(stream); throw error }
        cached = value
        // Do not enter the catalog lock while holding the vault lock: widget lookups acquire them in
        // the opposite order. Native mutation barriers also refresh synchronously after this returns.
        android.os.Handler(android.os.Looper.getMainLooper()).post { runCatching { AvidContinueWidget.refresh(context) } }
        return value
    }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
}

@CapacitorPlugin(name = "AvidSession")
class AvidSessionPlugin : Plugin() {
    private fun run(call: PluginCall, action: () -> JSONObject) {
        try { call.resolve(JSObject(action().toString())) }
        catch (_: Exception) { call.reject("Secure session access failed or its generation changed. Sign in again if the device key is unavailable.") }
    }
    @PluginMethod fun read(call: PluginCall) = run(call) { AvidSessionStore.read(context) }
    private fun resolve(call: PluginCall, future: java.util.concurrent.CompletableFuture<JSONObject>) {
        future.whenComplete { record, error ->
            if (error == null) call.resolve(JSObject(record.toString()))
            else call.reject("Secure session access failed or its generation changed. Sign in again if the device key is unavailable.")
        }
    }
    @PluginMethod fun write(call: PluginCall) {
        val session = call.getObject("session") ?: run { call.reject("A session is required."); return }
        resolve(call, AvidAuth.write(context, call.getString("expectedGeneration") ?: "", session, call.getBoolean("readOnly") ?: true))
    }
    @PluginMethod fun clear(call: PluginCall) = resolve(call, AvidAuth.clear(context, call.getString("expectedGeneration")))
}

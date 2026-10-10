package app.avid.playback

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.security.NetworkSecurityPolicy
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import androidx.browser.customtabs.CustomTabsIntent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** One short-lived, encrypted PKCE transaction and first callback. Never log this record or its URLs. */
internal object AvidOidcStore {
    private const val KEY = "app.avid.reader.oidc"
    private const val LIFETIME = 300_000.0
    private val transactionKeys = setOf("version", "state", "providerSlug", "profileId", "serverUrl", "redirectUri", "clientKind", "transportBaseUrl", "codeVerifier", "nonce", "createdAt", "expiresAt")
    private fun text(value: JSONObject, key: String, max: Int = 512): String {
        val result = value.get(key)
        require(result is String && result.length in 1..max)
        return result
    }
    private fun time(value: JSONObject, key: String): Double {
        val result = value.get(key)
        require(result is Number && result.toDouble().isFinite())
        return result.toDouble()
    }
    private fun validate(transaction: JSONObject, routing: JSONObject, now: Double) {
        require(transaction.keys().asSequence().all { it in transactionKeys })
        require(transaction.get("version") is Number && transaction.getDouble("version") == 1.0)
        text(transaction, "state"); text(transaction, "profileId")
        require(text(transaction, "providerSlug").matches(Regex("^[A-Za-z0-9][A-Za-z0-9_-]*$")))
        val server = text(transaction, "serverUrl", 2048)
        OidcBinding.httpUrl(server, false)
        require(text(transaction, "redirectUri") == OidcBinding.REDIRECT)
        require(text(transaction, "clientKind") in listOf("web", "native"))
        require(OidcBinding.validSecret(text(transaction, "codeVerifier", 43)) && OidcBinding.validSecret(text(transaction, "nonce", 43)))
        if (transaction.has("transportBaseUrl")) {
            val base = text(transaction, "transportBaseUrl", 2048)
            if (base.startsWith('/')) require(!base.startsWith("//") && !base.contains('?') && !base.contains('#'))
            else OidcBinding.httpUrl(base, false)
        }
        val created = time(transaction, "createdAt"); val expires = time(transaction, "expiresAt")
        require(OidcBinding.validWindow(created, expires, now))
        require(routing.keys().asSequence().all { it in setOf("profile", "provider", "readOnly", "createdAt") })
        val profile = routing.getJSONObject("profile")
        require(profile.keys().asSequence().all { it in setOf("id", "name", "url", "username", "version") })
        require(text(profile, "id") == text(transaction, "profileId") && text(profile, "url", 2048) == server)
        text(profile, "name")
        for (key in listOf("username", "version")) if (profile.has(key)) require(profile.get(key) is String && profile.getString(key).length <= 512)
        require(text(routing, "provider") == text(transaction, "providerSlug") && routing.get("readOnly") is Boolean)
        val routedAt = time(routing, "createdAt")
        require(routedAt > 0 && routedAt <= now && now - routedAt <= LIFETIME)
    }
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, "avid-oidc.bin"))
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(KEY, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    private fun write(context: Context, record: JSONObject) {
        val plain = record.toString().toByteArray(Charsets.UTF_8)
        require(plain.size <= 65536)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.iv + cipher.doFinal(plain)
        val file = file(context); val stream = file.startWrite()
        try { stream.write(bytes); file.finishWrite(stream) }
        catch (error: Exception) { file.failWrite(stream); throw error }
    }
    private fun read(context: Context): JSONObject? {
        val file = file(context)
        if (!file.baseFile.exists()) return null
        val bytes = file.readFully()
        require(bytes.size in 29..65564)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val record = JSONObject(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
        if (!record.has("transaction")) return null
        val transaction = record.getJSONObject("transaction")
        try {
            validate(transaction, record.getJSONObject("routing"), System.currentTimeMillis().toDouble())
            require(record.getString("generation") == AvidSessionStore.read(context).getString("generation"))
        } catch (_: Exception) { write(context, JSONObject()); return null }
        return record
    }
    @Synchronized fun save(context: Context, transaction: JSONObject, routing: JSONObject) {
        validate(transaction, routing, System.currentTimeMillis().toDouble())
        require(read(context)?.getJSONObject("transaction")?.getString("state") != transaction.getString("state")) { "This sign-in state is already in use." }
        val generation = AvidSessionStore.read(context).getString("generation")
        write(context, JSONObject().put("generation", generation).put("transaction", transaction).put("routing", routing))
    }
    @Synchronized fun take(context: Context, state: String): JSONObject? {
        require(state.length in 1..512)
        val record = read(context) ?: return null
        val transaction = record.getJSONObject("transaction")
        if (transaction.getString("state") != state) return null
        // Persist a tombstone before returning secrets; callback inbox and transaction disappear together.
        write(context, JSONObject())
        return transaction
    }
    @Synchronized fun pending(context: Context): JSONObject? {
        val record = read(context) ?: return null
        val transaction = record.getJSONObject("transaction")
        return JSONObject().put("state", transaction.getString("state")).put("expiresAt", transaction.getDouble("expiresAt"))
            .put("generation", record.getString("generation"))
            .put("routing", record.getJSONObject("routing")).apply {
                if (record.has("callbackUrl")) put("callbackUrl", record.getString("callbackUrl"))
            }
    }
    @Synchronized fun prepareOpen(context: Context, state: String, url: String): Uri {
        val record = read(context) ?: error("Sign-in expired or was cancelled.")
        val transaction = record.getJSONObject("transaction")
        require(transaction.getString("state") == state && !record.has("callbackUrl"))
        val checked = OidcBinding.authorization(url, state, transaction.getString("nonce"), transaction.getString("codeVerifier"))
        require(checked.scheme != "http" || NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(checked.host)) { "This provider requires a secure connection." }
        if (record.has("authorizationUrl")) require(record.getString("authorizationUrl") == url)
        else { record.put("authorizationUrl", url); write(context, record) }
        return Uri.parse(url)
    }
    @Synchronized fun cancel(context: Context, state: String?) {
        if (state == null) { write(context, JSONObject()); return }
        require(state.length in 1..512)
        val record = read(context) ?: return
        if (record.getJSONObject("transaction").getString("state") == state) write(context, JSONObject())
    }
    @Synchronized fun accept(context: Context, raw: String): Boolean {
        val record = read(context) ?: return false
        val state = record.getJSONObject("transaction").getString("state")
        if (!OidcBinding.callbackMatches(raw, state) || record.has("callbackUrl")) return false
        record.put("callbackUrl", raw)
        write(context, record)
        return true
    }
}

@CapacitorPlugin(name = "AvidOidc")
class AvidOidcPlugin : Plugin() {
    companion object {
        /** Called before bridge creation or delivery so a cold callback is durable before JS runs. */
        @JvmStatic fun captureCallback(context: Context, intent: Intent?): Boolean = try {
            val raw = intent?.dataString
            intent?.action == Intent.ACTION_VIEW && raw != null && raw.startsWith("${OidcBinding.REDIRECT}?") && AvidOidcStore.accept(context, raw)
        } catch (_: Exception) { false }
    }
    override fun load() {
        captureCallback(context, activity.intent)
        signalCallback()
    }
    override fun handleOnNewIntent(intent: Intent) {
        captureCallback(context, intent)
        try {
            if (AvidOidcStore.pending(context)?.optString("callbackUrl") == intent.dataString) signalCallback()
        } catch (_: Exception) { /* Unrelated intents never trigger authentication. */ }
    }
    private fun signalCallback() {
        try {
            if (AvidOidcStore.pending(context)?.has("callbackUrl") == true)
                notifyListeners("callbackAvailable", JSObject(), true)
        } catch (_: Exception) { /* An invalid or inaccessible attempt cannot trigger a sign-in. */ }
    }
    private fun run(call: PluginCall, action: () -> JSObject) {
        activity.runOnUiThread {
            try { call.resolve(action()) }
            catch (_: Exception) { call.reject("The secure sign-in attempt is invalid, expired, or unavailable. Start sign-in again.") }
        }
    }
    @PluginMethod fun capabilities(call: PluginCall) = call.resolve(JSObject().put("redirectUri", OidcBinding.REDIRECT).put("secureTransactions", true))
    @PluginMethod fun save(call: PluginCall) = run(call) {
        AvidOidcStore.save(context, call.getObject("transaction") ?: error("Missing transaction"), call.getObject("routing") ?: error("Missing routing"))
        JSObject()
    }
    @PluginMethod fun take(call: PluginCall) = run(call) {
        val transaction = AvidOidcStore.take(context, call.getString("state") ?: error("Missing state"))
        JSObject().apply { if (transaction != null) put("transaction", transaction) }
    }
    @PluginMethod fun pending(call: PluginCall) = run(call) {
        val pending = AvidOidcStore.pending(context)
        JSObject().apply { if (pending != null) put("pending", pending) }
    }
    @PluginMethod fun open(call: PluginCall) = run(call) {
        val state = call.getString("state") ?: error("Missing state")
        val uri = AvidOidcStore.prepareOpen(context, state, call.getString("url") ?: error("Missing authorization URL"))
        try {
            CustomTabsIntent.Builder().setShareState(CustomTabsIntent.SHARE_STATE_OFF).build().launchUrl(activity, uri)
        } catch (error: Exception) { AvidOidcStore.cancel(context, state); throw error }
        JSObject()
    }
    @PluginMethod fun cancel(call: PluginCall) = run(call) { AvidOidcStore.cancel(context, call.getString("state")); JSObject() }
}

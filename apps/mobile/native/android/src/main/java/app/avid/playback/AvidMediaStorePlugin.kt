package app.avid.playback

import android.content.Context
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.io.File
import java.util.concurrent.Executors

internal object AvidMediaStore {
    private var store: MediaTransferStore? = null
    fun account(context: Context): MediaAccount {
        val record = AvidSessionStore.read(context)
        val session = record.optJSONObject("session")
        return MediaAccount(record.getString("generation"), session?.let {
            JSONArray(listOf(AuthPolicy.server(it.getJSONObject("profile").getString("url")), it.getString("userId"))).toString()
        })
    }
    private fun get(context: Context) = store ?: MediaTransferStore(File(context.noBackupFilesDir, "avid-audio-files"), { account(context) }).also { store = it }
    // Keep the short file commit and vault generation check indivisible with native login/logout.
    fun <T> access(context: Context, action: (MediaTransferStore) -> T): T = synchronized(AvidSessionStore) { action(get(context.applicationContext)) }
    fun validate(context: Context, url: String, identity: MediaIdentity) = access(context) { it.validate(url, identity) }
    fun clearScope(context: Context, scope: String) = access(context) { it.clearScope(scope) }
}

@CapacitorPlugin(name = "AvidMediaStore")
class AvidMediaStorePlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private fun run(call: PluginCall, action: (MediaTransferStore) -> JSObject) {
        worker.execute {
            try { call.resolve(AvidMediaStore.access(context, action)) }
            catch (error: Exception) { call.reject(error.message ?: "The private audio import failed.") }
        }
    }
    @PluginMethod fun begin(call: PluginCall) = run(call) { store ->
        val size = call.getDouble("size") ?: Double.NaN
        require(size.isFinite() && size % 1 == 0.0 && size in 1.0..MediaTransferStore.MAX_FILE.toDouble())
        val id = store.begin(MediaIdentity(call.getString("accountScope") ?: "", call.getString("bookId") ?: "",
            call.getString("fileId") ?: "", call.getString("trackId") ?: ""), size.toLong(), call.getString("mime")?.takeIf { it.isNotBlank() } ?: "application/octet-stream")
        JSObject().put("id", id)
    }
    @PluginMethod fun append(call: PluginCall) = run(call) { store ->
        val data = call.getString("dataBase64") ?: ""
        val offset = call.getDouble("offset") ?: Double.NaN
        require(offset.isFinite() && offset % 1 == 0.0 && offset >= 0 && offset <= MediaTransferStore.MAX_FILE)
        require(data.length in 1..((MediaTransferStore.MAX_CHUNK + 2) / 3 * 4) && data.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
        store.append(call.getString("id") ?: "", offset.toLong(), Base64.decode(data, Base64.NO_WRAP)); JSObject()
    }
    @PluginMethod fun finish(call: PluginCall) = run(call) { JSObject().put("url", it.finish(call.getString("id") ?: "")) }
    @PluginMethod fun cancel(call: PluginCall) = run(call) { it.cancel(call.getString("id") ?: ""); JSObject() }
    @PluginMethod fun validate(call: PluginCall) = run(call) {
        JSObject().put("valid", it.validate(call.getString("url") ?: "", MediaIdentity(call.getString("accountScope") ?: "",
            call.getString("bookId") ?: "", call.getString("fileId") ?: "", call.getString("trackId") ?: "")))
    }
    override fun handleOnDestroy() { worker.shutdown(); super.handleOnDestroy() }
}

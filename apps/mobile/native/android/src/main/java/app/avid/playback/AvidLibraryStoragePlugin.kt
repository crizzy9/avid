package app.avid.playback

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

@CapacitorPlugin(name = "AvidLibraryStorage")
class AvidLibraryStoragePlugin : Plugin() {
    private val worker = Executors.newSingleThreadExecutor()
    private var store: LibraryStorageStore? = null
    private fun run(call: PluginCall, bindEpoch: Boolean = false, action: (LibraryStorageStore, JSONObject, String?) -> JSONObject) {
        // Copy the request before dispatch so a retained JSObject cannot change a queued operation.
        val request = JSONObject(call.data.toString())
        val queuedEpoch = if (bindEpoch) AvidSessionStore.withStorageEpoch { it } else null
        worker.execute {
            try {
                val current = store ?: LibraryStorageStore(File(context.noBackupFilesDir, "avid-library")).also { store = it }
                val result = if (queuedEpoch == null) action(current, request, null) else AvidSessionStore.withStorageEpoch { epoch ->
                    if (queuedEpoch != epoch) throw LibraryStorageException("The active connection changed before this file operation began.")
                    action(current, request, epoch)
                }
                call.resolve(JSObject(result.toString()))
            } catch (error: LibraryStorageException) { call.reject(error.message ?: "Invalid native library request.") }
            catch (_: Exception) { call.reject("The private library store could not complete this operation.") }
        }
    }
    @PluginMethod fun read(call: PluginCall) = run(call) { store, request, _ -> store.read(request) }
    @PluginMethod fun commit(call: PluginCall) = run(call) { store, request, _ -> store.commit(request) }
    @PluginMethod fun beginBlob(call: PluginCall) = run(call, true) { store, request, epoch -> store.beginBlob(request, checkNotNull(epoch)) }
    @PluginMethod fun appendBlob(call: PluginCall) = run(call, true) { store, request, epoch -> store.appendBlob(request, checkNotNull(epoch)) }
    @PluginMethod fun finishBlob(call: PluginCall) = run(call, true) { store, request, epoch -> store.finishBlob(request, checkNotNull(epoch)) }
    @PluginMethod fun readBlob(call: PluginCall) = run(call) { store, request, _ -> store.readBlob(request) }
    @PluginMethod fun cancelBlob(call: PluginCall) = run(call) { store, request, _ -> store.cancelBlob(request) }
    override fun handleOnDestroy() {
        worker.execute { store?.close(); store = null }
        worker.shutdown(); super.handleOnDestroy()
    }
}

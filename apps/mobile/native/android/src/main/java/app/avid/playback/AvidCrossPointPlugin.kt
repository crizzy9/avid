package app.avid.playback

import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.Executors

@CapacitorPlugin(name = "AvidCrossPoint")
class AvidCrossPointPlugin : Plugin() {
    private val transport = CrossPointTransport()
    private val workers = Executors.newFixedThreadPool(4)
    private fun work(call: PluginCall, action: () -> JSObject) {
        workers.execute { try { call.resolve(action()) } catch (_: Exception) { call.reject("The reader request failed, was canceled, or is unavailable. Check local-network access. Verify an attempted upload before sending again.") } }
    }
    @PluginMethod fun open(call: PluginCall) = work(call) {
        val headers = call.getArray("headers") ?: JSArray()
        val parsed = (0 until headers.length()).map { index -> val pair = headers.getJSONArray(index); require(pair.length() == 2); listOf(pair.getString(0), pair.getString(1)) }
        val head = transport.open(call.getString("id") ?: error("id"), call.getString("url") ?: error("url"), call.getString("method") ?: error("method"), parsed, call.getString("bodyBase64"))
        JSObject().put("id", head.id).put("status", head.status).put("statusText", head.message).put("headers", JSArray(head.headers))
    }
    @PluginMethod fun read(call: PluginCall) = work(call) {
        val chunk = transport.read(call.getString("id") ?: error("id"))
        JSObject().put("bytes", JSArray(chunk.bytes.map { it.toInt() and 255 })).put("done", chunk.done)
    }
    @PluginMethod fun close(call: PluginCall) {
        // Cancellation cannot queue behind the upload/read workers it needs to stop.
        try { transport.close(call.getString("id") ?: error("id")); call.resolve() } catch (_: Exception) { call.reject("Invalid reader request.") }
    }
    @PluginMethod fun discover(call: PluginCall) = work(call) {
        val readers = transport.discover(call.getString("id") ?: error("id"))
        JSObject().put("readers", JSArray(readers.map { JSObject().put("address", it.address).put("hostname", it.hostname) }))
    }
    override fun handleOnDestroy() { transport.dispose(); workers.shutdownNow(); super.handleOnDestroy() }
}

package app.avid.playback

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Shared UI catalog feed for the native Android media browser. iOS-only capabilities remain false. */
@CapacitorPlugin(name = "AvidSystemSurfaces")
class AvidSystemSurfacesPlugin : Plugin() {
    override fun load() { AvidAudioCatalog.initialize(context) }
    private fun run(call: PluginCall, operation: () -> JSObject) {
        activity.runOnUiThread { try { call.resolve(operation()) } catch (error: Exception) { call.reject(error.message, error) } }
    }
    @PluginMethod fun capabilities(call: PluginCall) = run(call) {
        JSObject().put("appGroupAvailable", false).put("spotlightAvailable", false).put("widgetExtensionEmbedded", false)
            .put("audioIntentsAvailable", false).put("controlsAvailable", false).put("carCatalogAvailable", true)
    }
    @PluginMethod fun activateAccount(call: PluginCall) = run(call) {
        AvidAudioCatalog.activate(call.getString("accountScope") ?: ""); JSObject()
    }
    @PluginMethod fun indexBooks(call: PluginCall) = run(call) {
        val input = call.getArray("books") ?: throw IllegalArgumentException("Books are required.")
        val ids = AvidAudioCatalog.index(call.getString("accountScope") ?: "", (0 until input.length()).map { input.getJSONObject(it) })
        JSObject().put("ids", org.json.JSONArray(ids))
    }
    @PluginMethod fun publishRecent(call: PluginCall) = run(call) {
        val input = call.getObject("book") ?: throw IllegalArgumentException("A book is required.")
        JSObject().put("id", AvidAudioCatalog.index(call.getString("accountScope") ?: "", listOf(input)).first())
    }
    @PluginMethod fun removeBooks(call: PluginCall) = run(call) {
        val input = call.getArray("ids") ?: throw IllegalArgumentException("Book IDs are required.")
        AvidAudioCatalog.remove((0 until input.length()).map { input.getString(it) }); JSObject()
    }
    @PluginMethod fun clearAccount(call: PluginCall) = run(call) { AvidAudioCatalog.clear(); JSObject() }
    // Android media browsing selects audio directly in the service; no reader navigation is queued.
    @PluginMethod fun consumeNavigation(call: PluginCall) = run(call) { JSObject() }
}

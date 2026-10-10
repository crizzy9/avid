package app.avid.playback

import android.content.Context
import android.content.Intent
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Shared catalog feed for the Android media browser and Continue Reading launcher widget. */
@CapacitorPlugin(name = "AvidSystemSurfaces")
class AvidSystemSurfacesPlugin : Plugin() {
    companion object {
        /** Capture before bridge creation so a cold widget launch survives JS startup. */
        @JvmStatic fun captureNavigation(context: Context, intent: Intent?): Boolean = try {
            intent?.action == Intent.ACTION_VIEW && intent.dataString?.let { AvidContinueStore.accept(context, it) } == true
        } catch (_: Exception) { false }
    }
    override fun load() {
        AvidAudioCatalog.initialize(context)
        AvidContinueWidget.refresh(context)
        signalNavigation()
    }
    override fun handleOnNewIntent(intent: Intent) { signalNavigation() }
    private fun signalNavigation() {
        try {
            if (AvidContinueStore.hasNavigation(context)) notifyListeners("navigationAvailable", JSObject(), true)
        } catch (_: Exception) { /* Invalid or unavailable secure metadata cannot navigate. */ }
    }
    private fun run(call: PluginCall, operation: () -> JSObject) {
        activity.runOnUiThread { try { call.resolve(operation()) } catch (error: Exception) { call.reject(error.message, error) } }
    }
    @PluginMethod fun capabilities(call: PluginCall) = run(call) {
        JSObject().put("appGroupAvailable", false).put("spotlightAvailable", false).put("widgetExtensionEmbedded", false)
            .put("audioIntentsAvailable", false).put("controlsAvailable", false).put("carCatalogAvailable", true)
            .put("androidWidgetAvailable", AvidContinueWidget.available(context))
    }
    @PluginMethod fun activateAccount(call: PluginCall) = run(call) {
        val scope = call.getString("accountScope") ?: ""
        AvidContinueStore.activate(context, scope)
        AvidContinueWidget.refresh(context)
        AvidAudioCatalog.activate(scope)
        JSObject()
    }
    @PluginMethod fun indexBooks(call: PluginCall) = run(call) {
        val input = call.getArray("books") ?: throw IllegalArgumentException("Books are required.")
        val scope = call.getString("accountScope") ?: ""
        val books = (0 until input.length()).map { input.getJSONObject(it) }
        val ids = AvidContinueStore.index(context, scope, books)
        AvidContinueWidget.refresh(context)
        AvidAudioCatalog.index(scope, books)
        JSObject().put("ids", org.json.JSONArray(ids))
    }
    @PluginMethod fun publishRecent(call: PluginCall) = run(call) {
        val input = call.getObject("book") ?: throw IllegalArgumentException("A book is required.")
        val scope = call.getString("accountScope") ?: ""
        val id = AvidContinueStore.index(context, scope, listOf(input), recent = true).first()
        AvidContinueWidget.refresh(context)
        AvidAudioCatalog.index(scope, listOf(input))
        JSObject().put("id", id)
    }
    @PluginMethod fun removeBooks(call: PluginCall) = run(call) {
        val input = call.getArray("ids") ?: throw IllegalArgumentException("Book IDs are required.")
        val removed = AvidContinueStore.remove(context, (0 until input.length()).map { input.getString(it) })
        AvidContinueWidget.refresh(context)
        // The audio browser uses its own stable IDs and contains audio only.
        val scope = AvidAudioCatalog.scope
        val audioIds = removed.filter { ContinueIdentity.identifier(ContinueIdentity.hash(scope), it.getString("bookId"), it.getString("fileId")) == it.getString("id") }
            .map { AvidAudioCatalog.id(scope, it.getString("bookId"), it.getString("fileId")) }.filter { AvidAudioCatalog.get(it) != null }
        if (audioIds.isNotEmpty()) AvidAudioCatalog.remove(audioIds)
        JSObject()
    }
    @PluginMethod fun clearAccount(call: PluginCall) = run(call) {
        AvidContinueStore.clear(context)
        AvidContinueWidget.refresh(context)
        AvidAudioCatalog.clear()
        JSObject()
    }
    @PluginMethod fun consumeNavigation(call: PluginCall) = run(call) {
        JSObject().apply { AvidContinueStore.consume(context)?.let { put("book", it) } }
    }
}

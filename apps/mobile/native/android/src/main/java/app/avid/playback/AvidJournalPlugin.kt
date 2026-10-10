package app.avid.playback

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AvidJournal")
class AvidJournalPlugin : Plugin() {
    override fun load() { AvidPlaybackJournal.initialize(context) }
    @PluginMethod fun recordProgress(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val saved = AvidSessionStore.read(context)
                val session = saved.getJSONObject("session")
                val url = session.getJSONObject("profile").getString("url").trimEnd('/').removeSuffix("/api/v1")
                val scope = call.getString("accountScope") ?: error("An account scope is required.")
                val identity = org.json.JSONArray(scope)
                require(identity.length() == 2 && identity.getString(0) == url && identity.getString(1) == session.getString("userId")) { "The checkpoint belongs to a different account." }
                val anchor = call.getObject("anchor") ?: error("A reading checkpoint is required.")
                val id = AvidPlaybackJournal.recordAnchor(scope, anchor, call.getBoolean("readOnly") != false || saved.optBoolean("readOnly", true))
                call.resolve(JSObject().put("id", id))
            } catch (error: Exception) { call.reject("The reading checkpoint could not be journaled.", error) }
        }
    }
    @PluginMethod fun drain(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val events = AvidPlaybackJournal.drain(call.getString("accountScope") ?: "", call.getInt("limit") ?: 200)
                call.resolve(JSObject().put("events", events))
            } catch (error: Exception) { call.reject("The native playback journal could not be read.", error) }
        }
    }
    @PluginMethod fun ack(call: PluginCall) {
        activity.runOnUiThread {
            try {
                val values = call.getArray("ids") ?: throw IllegalArgumentException("Journal IDs are required.")
                AvidPlaybackJournal.ack(call.getString("accountScope") ?: "", (0 until values.length()).map { values.getString(it) })
                call.resolve()
            } catch (error: Exception) { call.reject("The native playback journal could not be acknowledged.", error) }
        }
    }
}

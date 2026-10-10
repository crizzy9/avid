package app.avid.playback

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import androidx.core.view.WindowCompat
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Changes native chrome without recreating the Activity or resetting its WebView/reader. */
@CapacitorPlugin(name = "AvidAppearance")
class AvidAppearancePlugin : Plugin() {
    private fun storedTheme() = context.getSharedPreferences("avid-appearance", Context.MODE_PRIVATE).getString("theme", "system") ?: "system"
    override fun load() { activity.runOnUiThread { apply(storedTheme()) } }
    override fun handleOnResume() { activity.runOnUiThread { apply(storedTheme()) } }
    override fun handleOnConfigurationChanged(newConfig: Configuration) { activity.runOnUiThread { apply(storedTheme()) } }
    @PluginMethod fun setTheme(call: PluginCall) {
        val theme = call.getString("theme")
        val locale = call.getString("locale") ?: "en"
        if (!AvidStrings.valid(locale)) { call.reject("Unsupported language."); return }
        if (theme !in listOf("light", "dark", "system")) { call.reject("Choose light, dark, or system appearance."); return }
        activity.runOnUiThread {
            val preferences = context.getSharedPreferences("avid-appearance", Context.MODE_PRIVATE)
            val changed = preferences.getString("locale", "en") != locale
            preferences.edit().putString("theme", theme).putString("locale", locale).apply()
            apply(theme!!)
            if (changed) { AvidContinueWidget.refresh(context); AvidAudioCatalog.refreshLabels() }
            call.resolve()
        }
    }
    @Suppress("DEPRECATION")
    private fun apply(theme: String) {
        val dark = theme == "dark" || (theme == "system" && context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES)
        val color = Color.parseColor(if (dark) "#1e211f" else "#f7f6f2")
        val window = activity.window
        window.setBackgroundDrawable(ColorDrawable(color))
        window.decorView.setBackgroundColor(color)
        bridge.webView.setBackgroundColor(color)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
        // Android 15+ enforces transparent edge-to-edge bars; the themed window supplies their backing.
        // Older Android versions still require explicit bar colors. API24-25 need a dark nav background
        // because dark navigation icons are unavailable there.
        if (Build.VERSION.SDK_INT < 35) {
            window.statusBarColor = color
            window.navigationBarColor = if (Build.VERSION.SDK_INT < 26) Color.BLACK else color
        }
        if (Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
            window.isNavigationBarContrastEnforced = false
        }
    }
}

package app.avid.playback

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import app.avid.reader.MainActivity
import app.avid.reader.R
import kotlin.math.roundToInt

/** Launcher widget uses ordinary RemoteViews; all navigation is revalidated by the active-account store. */
class AvidContinueWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = update(context, manager, ids)
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) =
        update(context, manager, intArrayOf(id))
    companion object {
        fun available(context: Context): Boolean = try {
            val name = ComponentName(context, AvidContinueWidget::class.java)
            val manager = context.packageManager
            @Suppress("DEPRECATION") val receiver = manager.getReceiverInfo(name, 0)
            when (manager.getComponentEnabledSetting(name)) {
                PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> receiver.enabled && receiver.applicationInfo.enabled
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> receiver.applicationInfo.enabled
                else -> false
            }
        } catch (_: Exception) { false }
        fun refresh(context: Context) {
            AvidQuickActions.refresh(context)
            val manager = AppWidgetManager.getInstance(context)
            update(context, manager, manager.getAppWidgetIds(ComponentName(context, AvidContinueWidget::class.java)))
        }
        private fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
            if (ids.isEmpty()) return
            // Before first unlock, after logout, and on key failure the launcher shows no private metadata.
            val book = try { AvidContinueStore.recent(context) } catch (_: Exception) { null }
            val views = RemoteViews(context.packageName, R.layout.avid_continue_widget)
            views.setTextViewText(R.id.avid_widget_heading, "Avid · " + AvidStrings.text(context, "Continue reading"))
            val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (book == null) {
                views.setTextViewText(R.id.avid_widget_title, AvidStrings.text(context, "Your next chapter awaits."))
                views.setTextViewText(R.id.avid_widget_author, AvidStrings.text(context, "Open a book in Avid to continue here."))
                views.setViewVisibility(R.id.avid_widget_progress, View.GONE)
                views.setViewVisibility(R.id.avid_widget_percentage, View.GONE)
                intent.action = Intent.ACTION_MAIN
            } else {
                val percentage = (book.getDouble("progress").coerceIn(0.0, 1.0) * 100).roundToInt()
                views.setTextViewText(R.id.avid_widget_title, book.getString("title"))
                views.setTextViewText(R.id.avid_widget_author, book.getString("author"))
                views.setTextViewText(R.id.avid_widget_percentage, AvidStrings.text(context, "{percent}% complete").replace("{percent}", percentage.toString()))
                views.setViewVisibility(R.id.avid_widget_progress, View.VISIBLE)
                views.setViewVisibility(R.id.avid_widget_percentage, View.VISIBLE)
                views.setProgressBar(R.id.avid_widget_progress, 100, percentage, false)
                intent.action = Intent.ACTION_VIEW
                intent.data = Uri.parse("avid://resume?identifier=${book.getString("id")}")
            }
            // Explicit immutable intents cannot have book IDs or account details substituted by the host.
            val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            views.setOnClickPendingIntent(R.id.avid_widget_card, pending)
            ids.forEach { manager.updateAppWidget(it, views) }
        }
    }
}

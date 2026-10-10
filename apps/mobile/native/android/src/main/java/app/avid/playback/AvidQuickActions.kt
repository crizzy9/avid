package app.avid.playback

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import app.avid.reader.MainActivity
import app.avid.reader.R

/** Launcher entry points contain opaque identities; the receiver rechecks the secure account. */
internal object AvidQuickActions {
    private const val PREFIX = "avid.recent."
    fun refresh(context: Context) {
        if (Build.VERSION.SDK_INT < 25) return
        // Shortcut storage is unavailable before the user's first unlock.
        runCatching {
            val manager = context.getSystemService(ShortcutManager::class.java) ?: return
            val books = runCatching { AvidContinueStore.recentBooks(context, manager.maxShortcutCountPerActivity) }.getOrDefault(emptyList())
            val desired = books.mapIndexed { rank, book ->
                val id = book.getString("id")
                val title = book.getString("title")
                val label = AvidStrings.text(context, "Continue {title}").replace("{title}", title)
                ShortcutInfo.Builder(context, PREFIX + id)
                    .setActivity(ComponentName(context, MainActivity::class.java))
                    .setShortLabel(title.substring(0, title.offsetByCodePoints(0, title.codePointCount(0, title.length).coerceAtMost(40))))
                    .setLongLabel(label)
                    .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                    .setRank(rank)
                    .setIntent(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
                        .setData(Uri.parse("avid://resume?identifier=$id"))
                        .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
                    .build()
            }
            val ids = desired.map { it.id }.toSet()
            val existing = (manager.dynamicShortcuts + manager.pinnedShortcuts).filter { it.id.startsWith(PREFIX) }.distinctBy { it.id }
            val stale = existing.filter { it.id !in ids }.map { it.id }
            val unavailable = existing.filter { !runCatching { AvidContinueStore.permitsShortcut(context, it.id.removePrefix(PREFIX)) }.getOrDefault(false) }.map { it.id }
            if (unavailable.isNotEmpty()) {
                manager.disableShortcuts(unavailable, AvidStrings.text(context, "This book is not available in the currently signed-in account. Open Avid to continue."))
            }
            if (stale.isNotEmpty()) {
                // A still-permitted pinned book can remain usable after it leaves the recent list.
                manager.removeDynamicShortcuts(stale)
            }
            if (desired.isEmpty() || manager.isRateLimitingActive) return
            val current = manager.dynamicShortcuts.filter { it.id.startsWith(PREFIX) }.sortedBy { it.rank }
            val same = current.size == desired.size && current.zip(desired).all { (a, b) ->
                a.id == b.id && a.shortLabel.toString() == b.shortLabel.toString() && a.longLabel.toString() == b.longLabel.toString() && a.rank == b.rank && a.isEnabled
            }
            if (!same) {
                manager.enableShortcuts(ids.toList())
                manager.setDynamicShortcuts(desired)
            }
        }
    }
}

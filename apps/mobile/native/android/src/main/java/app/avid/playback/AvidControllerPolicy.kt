package app.avid.playback

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import androidx.media3.session.MediaSession
import java.security.MessageDigest

// Production certificate fingerprints published by Google's UAMP sample, commit
// 9498d991ab84b708e2130b6217483d4cccd4bbfd, allowed_media_browser_callers.xml.
// No debug/simulator certificate is accepted by this release policy.
private val autoProductionSigners = setOf(
    "fdb00c43dbde8b51cb312aa81d3b5fa17713adb94b28f598d77f8eb89daceedf",
    "1ca8dcc0bed3cbd872d2cb791200c0292ca9975768a82d676b8b424fb65b5295"
)
fun authorizedCarPackage(packageName: String, verifiedUid: Boolean, fingerprints: Set<String>): Boolean =
    verifiedUid && packageName == "com.google.android.projection.gearhead" && fingerprints.any { it in autoProductionSigners }

@androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
object AvidControllerPolicy {
    @Suppress("DEPRECATION")
    fun allows(context: Context, controller: MediaSession.ControllerInfo): Boolean {
        if (controller.uid == Process.myUid() || controller.isTrusted) return true
        if (controller.uid < 0 || controller.packageName != "com.google.android.projection.gearhead") return false
        return try {
            val manager = context.packageManager
            val uidMatches = manager.getPackagesForUid(controller.uid)?.contains(controller.packageName) == true
            val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
            val info = manager.getPackageInfo(controller.packageName, flags)
            val certificates = if (Build.VERSION.SDK_INT >= 28) {
                val signing = info.signingInfo ?: return false
                if (signing.hasMultipleSigners()) signing.apkContentsSigners else signing.signingCertificateHistory
            } else info.signatures
            val hashes = certificates.orEmpty().map { signature ->
                MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
            }.toSet()
            authorizedCarPackage(controller.packageName, uidMatches, hashes)
        } catch (_: Exception) { false }
    }
}

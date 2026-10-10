package app.avid.playback

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ControllerPolicyTest {
    private val production = "fdb00c43dbde8b51cb312aa81d3b5fa17713adb94b28f598d77f8eb89daceedf"
    @Test fun requiresPackageUidAndProductionSignature() {
        assertTrue(authorizedCarPackage("com.google.android.projection.gearhead", true, setOf(production)))
        assertFalse(authorizedCarPackage("com.google.android.projection.gearhead", false, setOf(production)))
        assertFalse(authorizedCarPackage("example.spoof", true, setOf(production)))
        assertFalse(authorizedCarPackage("com.google.android.projection.gearhead", true, setOf("unknown")))
    }
}

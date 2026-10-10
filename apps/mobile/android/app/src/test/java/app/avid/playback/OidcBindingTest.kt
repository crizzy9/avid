package app.avid.playback

import java.net.URLEncoder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class OidcBindingTest {
    private val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    private val nonce = "n".repeat(43)
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8")
    private fun authorization() = "https://identity.example/authorize?response_type=code&response_mode=query&client_id=avid&scope=openid%20profile" +
        "&state=state&nonce=$nonce&redirect_uri=${encode(OidcBinding.REDIRECT)}&code_challenge_method=S256&code_challenge=${OidcBinding.challenge(verifier)}"
    @Test fun derivesTheRfc7636ChallengeWithoutPadding() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", OidcBinding.challenge(verifier))
    }
    @Test fun acceptsOnlyTheExactCallbackBaseAndSingleMatchingState() {
        assertTrue(OidcBinding.callbackMatches("avid://oauth2-callback?state=state&code=code", "state"))
        assertTrue(OidcBinding.callbackMatches("avid://oauth2-callback?state=state&error=access_denied", "state"))
        for (url in listOf(
            "avid://other?state=state&code=code", "avid://oauth2-callback/?state=state&code=code",
            "avid://oauth2-callback:80?state=state&code=code", "avid://user@oauth2-callback?state=state&code=code",
            "avid://oauth2-callback?state=other&code=code", "avid://oauth2-callback?state=state&state=state&code=code",
            "avid://oauth2-callback?state=state&s%74ate=state&code=code", "avid://oauth2-callback?state=state&code=code#fragment",
            "avid://oauth2-callback?state=state&code=code&error=access_denied", "avid://oauth2-callback?state=state&code=",
        )) assertFalse(url.substringBefore('?'), OidcBinding.callbackMatches(url, "state"))
    }
    @Test fun validatesEveryAuthorizationBindingBeforeBrowserLaunch() {
        assertEquals("identity.example", OidcBinding.authorization(authorization(), "state", nonce, verifier).host)
        for (url in listOf(
            authorization().replace("state=state", "state=other"),
            authorization().replace("nonce=$nonce", "nonce=${"x".repeat(43)}"),
            authorization().replace(encode(OidcBinding.REDIRECT), encode("avid://other")),
            authorization().replace("S256", "plain"),
            authorization().replace(OidcBinding.challenge(verifier), "x".repeat(43)),
            authorization() + "&state=state", authorization() + "&code_verifier=$verifier", authorization().replace("https://", "https://user:password@"),
            authorization().replace("response_mode=query", "response_mode=fragment"),
        )) assertThrows(IllegalArgumentException::class.java) { OidcBinding.authorization(url, "state", nonce, verifier) }
    }
    @Test fun enforcesExpiryClockRollbackAndMaximumLifetime() {
        assertTrue(OidcBinding.validWindow(1000.0, 301000.0, 1000.0))
        assertFalse(OidcBinding.validWindow(1000.0, 301000.0, 301000.0))
        assertFalse(OidcBinding.validWindow(1000.0, 301001.0, 1001.0))
        assertFalse(OidcBinding.validWindow(1000.0, 2000.0, 999.0))
        assertFalse(OidcBinding.validWindow(1000.0, Double.POSITIVE_INFINITY, 1001.0))
    }
}

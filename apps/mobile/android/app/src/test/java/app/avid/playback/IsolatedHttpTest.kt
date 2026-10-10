package app.avid.playback

import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.net.CookieHandler
import java.net.CookieManager
import java.net.HttpCookie

class IsolatedHttpTest {
    @Test fun `network neither reads nor writes the global cookie handler`() {
        MockWebServer().use { server ->
            server.start()
            val original = CookieHandler.getDefault()
            val global = CookieManager()
            global.cookieStore.add(server.url("/").toUri(), HttpCookie("existing_account", "old-secret"))
            CookieHandler.setDefault(global)
            try {
                server.enqueue(MockResponse().addHeader("Set-Cookie", "refresh_token=stale-response; Path=/").setBody("{}"))
                server.enqueue(MockResponse().setBody("{}"))
                val client = IsolatedHttp.client()
                repeat(2) { client.newCall(Request.Builder().url(server.url("/auth")).build()).execute().use { assertEquals(200, it.code) } }
                assertNull(server.takeRequest().getHeader("Cookie"))
                assertNull(server.takeRequest().getHeader("Cookie"))
                assertFalse(global.cookieStore.cookies.any { it.name == "refresh_token" })
            } finally { CookieHandler.setDefault(original) }
        }
    }
    @Test fun `redirect response cannot forward explicit credentials to another origin`() {
        MockWebServer().use { origin ->
            MockWebServer().use { redirected ->
                origin.start(); redirected.start()
                origin.enqueue(MockResponse().setResponseCode(302).addHeader("Location", redirected.url("/capture").toString()))
                redirected.enqueue(MockResponse().setBody("unexpected"))
                IsolatedHttp.client().newCall(Request.Builder().url(origin.url("/api/audio"))
                    .header("Authorization", "Bearer test-token").header("Cookie", "access_token=test-token").build())
                    .execute().use { assertEquals(302, it.code) }
                assertEquals(0, redirected.requestCount)
                assertEquals("Bearer test-token", origin.takeRequest().getHeader("Authorization"))
            }
        }
    }
}

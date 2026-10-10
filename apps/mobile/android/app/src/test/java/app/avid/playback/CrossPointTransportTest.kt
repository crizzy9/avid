package app.avid.playback

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class CrossPointTransportTest {
    @Test fun `discovery uses the peer HTTP address and rejects public or malformed replies`() {
        val ip = InetAddress.getByName("192.168.1.2")
        val reader = CrossPointTransport.reply("crosspoint (on reader-2);81".toByteArray(), ip)!!
        assertEquals("http://192.168.1.2", reader.address)
        assertEquals("reader-2", reader.hostname)
        for (bad in listOf("crosspoint (on a);0", "crosspoint (on a);65536", "crosspoint (on <script>);81", "crosspoint (on a);81\n", "other")) assertNull(CrossPointTransport.reply(bad.toByteArray(), ip))
        assertNull(CrossPointTransport.reply("crosspoint (on a);81".toByteArray(), InetAddress.getByName("8.8.8.8")))
        for (bad in listOf("http://a/delete?path=/book.epub", "http://a/api/status?plugin=avid&plugin=x", "http://a/api/files?path=/../x", "http://u:p@a/api/status?plugin=avid")) assertTrue(runCatching { CrossPointTransport.route(bad, "GET") }.isFailure)
    }
    @Test fun `redirect never forwards credentials or opens a second destination`() {
        MockWebServer().use { origin -> MockWebServer().use { redirected ->
            origin.start(); redirected.start()
            origin.enqueue(MockResponse().setResponseCode(302).addHeader("Location", redirected.url("/capture")))
            val transport = CrossPointTransport()
            try {
                assertTrue(runCatching { transport.open(UUID.randomUUID().toString(), origin.url("/api/status?plugin=avid").toString(), "GET", listOf(listOf("Cookie", "secret"), listOf("Authorization", "secret")), null) }.isFailure)
                val request = origin.takeRequest()
                assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Authorization"))
                assertEquals(origin.url("/").toUri().rawAuthority, request.getHeader("Host"))
                assertEquals(0, redirected.requestCount)
            } finally { transport.dispose() }
        } }
    }
    @Test fun `download chunks preserve bytes and declared oversize metadata fails`() {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setBody("x".repeat(600000)))
            server.enqueue(MockResponse().setHeader("Content-Length", "65537").setBody("x".repeat(65537)))
            val transport = CrossPointTransport(); val id = UUID.randomUUID().toString()
            try {
                transport.open(id, server.url("/download?path=/book.epub").toString(), "GET", emptyList(), null)
                var count = 0
                do { val chunk = transport.read(id); assertTrue(chunk.bytes.size <= 256 * 1024); assertTrue(chunk.bytes.all { it == 120.toByte() }); count += chunk.bytes.size } while (!chunk.done)
                assertEquals(600000, count)
                assertTrue(runCatching { transport.open(UUID.randomUUID().toString(), server.url("/api/status?plugin=avid").toString(), "GET", emptyList(), null) }.isFailure)
            } finally { transport.dispose() }
        }
    }
    @Test fun `cancel reaches a pending native request and blocks late open`() {
        MockWebServer().use { server ->
            server.start(); server.enqueue(MockResponse().setHeadersDelay(5, TimeUnit.SECONDS).setBody("{}"))
            val transport = CrossPointTransport(); val id = UUID.randomUUID().toString(); val executor = Executors.newSingleThreadExecutor()
            try {
                val pending = executor.submit<Boolean> { runCatching { transport.open(id, server.url("/api/status?plugin=avid").toString(), "GET", emptyList(), null) }.isFailure }
                assertNotNull(server.takeRequest(2, TimeUnit.SECONDS))
                transport.close(id)
                assertTrue(pending.get(2, TimeUnit.SECONDS))
                val late = UUID.randomUUID().toString(); transport.close(late)
                assertTrue(runCatching { transport.open(late, server.url("/api/status?plugin=avid").toString(), "GET", emptyList(), null) }.isFailure)
            } finally { transport.dispose(); executor.shutdownNow() }
        }
    }
}

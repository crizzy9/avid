package app.avid.playback

import org.junit.Assert.*
import org.junit.Test

class AuthPolicyTest {
    @Test fun `late response cannot apply cookies after logout changes generation`() {
        val queue = AuthCommitQueue { it() }
        var generation = "before"
        var account = "alice"
        val applied = mutableListOf<String>()
        var finishClear: (() -> Unit)? = null
        queue.submit { done ->
            // removeAllCookies is asynchronous. New commits must wait for its callback and generation.
            finishClear = { generation = "after"; account = ""; done() }
        }
        queue.submit { done ->
            if (AuthPolicy.owns("before", generation, "alice", account)) applied.add("stale-response")
            done()
        }
        assertTrue(applied.isEmpty())
        finishClear!!()
        assertTrue(applied.isEmpty())
        assertEquals("after", generation)
    }
    @Test fun `logout waits for already accepted cookie commit then removes its credentials`() {
        val queue = AuthCommitQueue { it() }
        val operations = mutableListOf<String>()
        var finishCookie: (() -> Unit)? = null
        queue.submit { done ->
            operations.add("cookie-start")
            finishCookie = { operations.add("cookie-finish"); operations.add("vault-rotate"); done() }
        }
        queue.submit { done -> operations.add("cookie-clear"); operations.add("vault-clear"); done() }
        assertEquals(listOf("cookie-start"), operations)
        finishCookie!!()
        assertEquals(listOf("cookie-start", "cookie-finish", "vault-rotate", "cookie-clear", "vault-clear"), operations)
    }
    @Test fun `supersession and identity failure prevent a refresh commit`() {
        assertFalse(AuthPolicy.owns("one", "two", "alice", "alice"))
        assertFalse(AuthPolicy.owns("one", "one", "alice", "bob"))
        assertFalse(AuthPolicy.verifiedUser("12", "13", true))
        assertFalse(AuthPolicy.verifiedUser("12", "12", false))
        assertTrue(AuthPolicy.owns("one", "one", "alice", "alice") && AuthPolicy.verifiedUser("12", "12", true))
    }
    @Test fun `fresh credential read waits for its cookie commit callback`() {
        val queue = AuthCommitQueue { it() }
        var generation = "before"
        var freshResult: String? = null
        var finishCookie: (() -> Unit)? = null
        queue.submit { done ->
            generation = "after" // durable CAS succeeds before cookies finish
            finishCookie = done
        }
        queue.submit { done -> freshResult = generation; done() }
        assertNull(freshResult)
        finishCookie!!()
        assertEquals("after", freshResult)
    }
    @Test fun `only own normalized server API sources require credentials`() {
        val server = "https://example.test/books"
        assertTrue(AuthPolicy.protectedMedia("https://example.test/books/api/v1/files/2/content?stream=1", server))
        listOf("https://other.test/books/api/v1/files/2/content", "https://example.test.evil/books/api/v1/files/2/content",
            "http://example.test/books/api/v1/files/2/content", "https://example.test:8443/books/api/v1/files/2/content",
            "https://user:secret@example.test/books/api/v1/files/2/content", "https://example.test/books/public/chapter.mp3",
            "https://example.test/books/api/../public/file", "https://example.test/books/api/%2e%2e/public/file", "file:///books/chapter.mp3")
            .forEach { assertFalse(it, AuthPolicy.protectedMedia(it, server)) }
    }
    @Test fun `expiry schedules early refresh but never grants identity`() {
        assertTrue(AuthPolicy.needsRefresh(null, 1_000_000))
        assertTrue(AuthPolicy.needsRefresh(Double.NaN, 1_000_000))
        assertTrue(AuthPolicy.needsRefresh(1090.0, 1_000_000))
        assertFalse(AuthPolicy.needsRefresh(1091.0, 1_000_000))
        assertFalse(AuthPolicy.verifiedUser("alice", "bob", true))
    }
}

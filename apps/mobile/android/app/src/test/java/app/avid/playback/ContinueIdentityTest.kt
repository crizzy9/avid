package app.avid.playback

import org.junit.Assert.*
import org.junit.Test

class ContinueIdentityTest {
    private val scope = ContinueIdentity.hash("[\"https://example.test\",\"alice\"]")
    private val account = ContinueIdentity.account("https://example.test", "alice")
    @Test fun `opaque identity binds account book and file`() {
        val id = ContinueIdentity.identifier(scope, "book-1", "file-1")
        assertEquals(64, id.length)
        assertTrue(ContinueIdentity.permits(account, account, scope, id, "book-1", "file-1", "epub"))
        assertTrue(ContinueIdentity.permits(account, account, scope, id, "book-1", "file-1", "audio"))
        assertFalse(ContinueIdentity.permits(null, account, scope, id, "book-1", "file-1", "epub"))
        assertFalse(ContinueIdentity.permits(ContinueIdentity.account("https://example.test", "bob"), account, scope, id, "book-1", "file-1", "epub"))
        assertFalse(ContinueIdentity.permits(ContinueIdentity.account("https://other.test", "alice"), account, scope, id, "book-1", "file-1", "epub"))
        assertFalse(ContinueIdentity.permits(account, account, scope, id, "book-2", "file-1", "epub"))
        assertFalse(ContinueIdentity.permits(account, account, scope, id, "book-1", "file-2", "epub"))
        assertFalse(ContinueIdentity.permits(account, account, scope, id, "book-1", "file-1", "html"))
    }
    @Test fun `resume links have one exact opaque identifier and no alternate routing`() {
        val id = ContinueIdentity.identifier(scope, "book-1", "file-1")
        assertEquals(id, ContinueIdentity.linkIdentifier("avid://resume?identifier=$id"))
        listOf("avid://resume/?identifier=$id", "avid://resume:80?identifier=$id", "avid://attacker@resume?identifier=$id",
            "https://resume?identifier=$id", "avid://resume?identifier=$id#fragment", "avid://resume?identifier=$id&identifier=$id",
            "avid://resume?identifier=$id&bookId=other", "avid://resume?%69dentifier=$id", "avid://resume?identifier=unknown")
            .forEach { assertNull(it, ContinueIdentity.linkIdentifier(it)) }
    }
    @Test fun `length prefix prevents identity field collision`() {
        assertNotEquals(ContinueIdentity.account("ab", "c"), ContinueIdentity.account("a", "bc"))
        assertNotEquals(ContinueIdentity.identifier(scope, "ab", "c"), ContinueIdentity.identifier(scope, "a", "bc"))
    }
}

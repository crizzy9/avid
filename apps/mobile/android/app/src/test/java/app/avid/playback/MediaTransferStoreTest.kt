package app.avid.playback

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.net.URI

class MediaTransferStoreTest {
    @get:Rule val temp = TemporaryFolder()
    private val identity = MediaIdentity("[\"https://example.test\",\"u\"]", "book", "file", "track")
    @Test fun `ordered import produces durable exact identity receipt and survives refresh`() {
        var account = MediaAccount("first", identity.scope)
        val root = temp.newFolder()
        val store = MediaTransferStore(root, { account })
        val id = store.begin(identity, 5, "audio/mpeg")
        store.append(id, 0, byteArrayOf(1, 2)); store.append(id, 2, byteArrayOf(3, 4, 5))
        val url = store.finish(id)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), File(URI(url)).readBytes())
        account = MediaAccount("rotated", identity.scope)
        val reloaded = MediaTransferStore(root, { account })
        assertTrue(reloaded.validate(url, identity))
        assertFalse(reloaded.validate(url, identity.copy(trackId = "other")))
        assertFalse(reloaded.validate(url, identity.copy(bookId = "other")))
        account = MediaAccount("other-user", "other")
        assertFalse(reloaded.validate(url, identity))
    }
    @Test fun `generation change rejects late bytes and finish without exposing a receipt`() {
        var account = MediaAccount("first", identity.scope)
        val store = MediaTransferStore(temp.newFolder(), { account })
        val id = store.begin(identity, 2, "audio/mpeg")
        store.append(id, 0, byteArrayOf(1, 2))
        account = MediaAccount("new-login", identity.scope)
        assertThrows(IllegalArgumentException::class.java) { store.finish(id) }
        assertThrows(IllegalArgumentException::class.java) { store.append(id, 2, byteArrayOf(3)) }
    }
    @Test fun `empty vault only permits exact local demo account`() {
        val empty = MediaAccount("durable-empty", null)
        assertTrue(MediaTransferStore.allowed(MediaTransferStore.DEMO_SCOPE, empty))
        assertFalse(MediaTransferStore.allowed(identity.scope, empty))
        assertFalse(MediaTransferStore.allowed("[\"https://demo.avid.invalid/\",\"demo\"]", empty))
        assertFalse(MediaTransferStore.allowed(MediaTransferStore.DEMO_SCOPE, MediaAccount("login", identity.scope)))
    }
    @Test fun `rejects reordered oversized incomplete and arbitrary local files`() {
        val store = MediaTransferStore(temp.newFolder(), { MediaAccount("g", identity.scope) })
        val id = store.begin(identity, 4, "audio/mpeg")
        assertThrows(IllegalArgumentException::class.java) { store.append(id, 1, byteArrayOf(1)) }
        assertThrows(IllegalArgumentException::class.java) { store.append(id, 0, ByteArray(MediaTransferStore.MAX_CHUNK + 1)) }
        assertThrows(IllegalArgumentException::class.java) { store.finish(id) }
        val arbitrary = temp.newFile().apply { writeBytes(byteArrayOf(1)) }
        assertFalse(store.validate(arbitrary.toURI().toASCIIString(), identity))
        assertFalse(store.validate("content://other/file", identity))
        assertThrows(IllegalArgumentException::class.java) { store.cancel("../../anything") }
    }
    @Test fun `abandoned transfer expires and interrupted process never exposes partial audio`() {
        var now = 0L
        val root = temp.newFolder()
        val store = MediaTransferStore(root, { MediaAccount("g", identity.scope) }, { now })
        val id = store.begin(identity, 2, "audio/mpeg"); store.append(id, 0, byteArrayOf(1))
        now = MediaTransferStore.PART_TTL
        assertThrows(IllegalStateException::class.java) { store.append(id, 1, byteArrayOf(2)) }
        assertFalse(File(root, "$id.part").exists())
        val next = store.begin(identity, 2, "audio/mpeg"); store.append(next, 0, byteArrayOf(1))
        MediaTransferStore(root, { MediaAccount("g", identity.scope) })
        assertFalse(File(root, "$next.part").exists())
    }
    @Test fun `account clear removes receipt before files can be reused`() {
        val root = temp.newFolder()
        val store = MediaTransferStore(root, { MediaAccount("g", identity.scope) })
        val id = store.begin(identity, 1, "audio/mpeg"); store.append(id, 0, byteArrayOf(1)); val url = store.finish(id)
        store.clearScope(identity.scope)
        assertFalse(store.validate(url, identity)); assertFalse(File(URI(url)).exists())
    }
    @Test fun `only exact content and identity deduplicate after hashing complete bytes`() {
        val root = temp.newFolder()
        val store = MediaTransferStore(root, { MediaAccount("g", identity.scope) })
        fun copy(bytes: ByteArray, target: MediaIdentity = identity): String {
            val id = store.begin(target, bytes.size.toLong(), "audio/mpeg"); store.append(id, 0, bytes); return store.finish(id)
        }
        val first = copy(byteArrayOf(1, 2))
        assertEquals(first, copy(byteArrayOf(1, 2)))
        assertNotEquals(first, copy(byteArrayOf(2, 1)))
        assertNotEquals(first, copy(byteArrayOf(1, 2), identity.copy(trackId = "another")))
    }
    @Test fun `accepted multibyte identities remain readable after process restart`() {
        val large = MediaIdentity("[\"https://example.test/${"音".repeat(6000)}\",\"u\"]", "本".repeat(2048), "本".repeat(2048), "本".repeat(2048))
        val root = temp.newFolder()
        val store = MediaTransferStore(root, { MediaAccount("g", large.scope) })
        val id = store.begin(large, 1, "audio/mpeg"); store.append(id, 0, byteArrayOf(1)); val url = store.finish(id)
        assertTrue(MediaTransferStore(root, { MediaAccount("g", large.scope) }).validate(url, large))
    }
}

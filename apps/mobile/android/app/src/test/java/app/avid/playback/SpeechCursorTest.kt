package app.avid.playback

import org.junit.Assert.*
import org.junit.Test

class SpeechCursorTest {
    @Test fun `stale cancellation and callbacks cannot stop or move a newer utterance`() {
        val cursor = SpeechCursor()
        val old = cursor.begin("old", "Old words", 4000)
        val next = cursor.begin("next", "New words", 4000)
        assertFalse(cursor.cancel("old"))
        assertSame(next, cursor.active)
        assertNull(cursor.matching(old.engineId))
        assertNull(cursor.range(old.engineId, 0, 3))
        assertTrue(cursor.cancel("next"))
        assertNull(cursor.matching(next.engineId))
    }
    @Test fun `engine split preserves every UTF16 unit and converts real ranges`() {
        val cursor = SpeechCursor()
        val text = "word ".repeat(819) + "x"
        val attempt = cursor.begin("id", text, 4000)
        assertEquals(4096, text.length)
        assertEquals(text, attempt.parts.joinToString("") { it.text })
        assertTrue(attempt.parts.all { it.text.length <= 4000 })
        attempt.index = 1
        val part = attempt.parts[1]
        assertEquals(part.start until part.start + 4, cursor.range(attempt.engineId, 0, 4))
    }
    @Test fun `engine split and reported ranges never cut surrogate pairs`() {
        val cursor = SpeechCursor()
        val text = "x".repeat(3999) + "😀" + "tail"
        val attempt = cursor.begin("id", text, 4000)
        assertEquals(3999, attempt.parts[0].text.length)
        assertEquals("😀tail", attempt.parts[1].text)
        attempt.index = 1
        assertNull(cursor.range(attempt.engineId, 0, 1))
        assertEquals(3999 until 4001, cursor.range(attempt.engineId, 0, 2))
        assertNull(cursor.range(attempt.engineId, -1, 2))
        assertNull(cursor.range(attempt.engineId, 0, 100))
    }
    @Test fun `global cancellation invalidates pending initialization work`() {
        val cursor = SpeechCursor()
        val pending = cursor.begin("pending", "Waiting for a voice", 4000)
        assertTrue(cursor.cancel())
        assertNull(cursor.matching(pending.engineId))
    }
    @Test(expected = IllegalArgumentException::class) fun `rejects text beyond the bridge bound`() {
        SpeechCursor().begin("id", "x".repeat(4097), 4000)
    }
}

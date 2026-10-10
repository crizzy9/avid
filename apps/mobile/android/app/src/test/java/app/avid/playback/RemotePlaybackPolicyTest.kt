package app.avid.playback

import org.junit.Assert.*
import org.junit.Test

class RemotePlaybackPolicyTest {
    private val chapters = listOf(AudioChapter("a", "One", 0.0, 100.0), AudioChapter("b", "Two", 100.0, 150.0))
    @Test fun `chapter remote restarts after three seconds and otherwise chooses previous`() {
        assertEquals(100.0, RemotePlaybackPolicy.target(chapters, 104.0, false, "chapter", 30.0, 250.0), 0.0)
        assertEquals(0.0, RemotePlaybackPolicy.target(chapters, 103.0, false, "chapter", 30.0, 250.0), 0.0)
        assertEquals(100.0, RemotePlaybackPolicy.target(chapters, 40.0, true, "chapter", 30.0, 250.0), 0.0)
        assertEquals(170.0, RemotePlaybackPolicy.target(chapters, 140.0, true, "chapter", 30.0, 250.0), 0.0)
        assertEquals(250.0, RemotePlaybackPolicy.target(chapters, 250.0, true, "chapter", 30.0, 250.0), 0.0)
        assertEquals(100.0, RemotePlaybackPolicy.target(chapters, 250.0, false, "chapter", 30.0, 250.0), 0.0)
    }
    @Test fun `time fallback crosses track boundaries and clamps book endpoints`() {
        assertEquals(110.0, RemotePlaybackPolicy.target(emptyList(), 80.0, true, "chapter", 30.0, 250.0), 0.0)
        assertEquals(50.0, RemotePlaybackPolicy.target(emptyList(), 80.0, false, "chapter", 30.0, 250.0), 0.0)
        assertEquals(0.0, RemotePlaybackPolicy.target(chapters, 5.0, false, "time", 20.0, 250.0), 0.0)
        assertEquals(250.0, RemotePlaybackPolicy.target(chapters, 240.0, true, "time", 20.0, 250.0), 0.0)
    }
    @Test fun `chapters must remain ordered and non overlapping`() {
        RemotePlaybackPolicy.validate(chapters)
        assertThrows(IllegalArgumentException::class.java) { RemotePlaybackPolicy.validate(chapters.reversed()) }
        assertThrows(IllegalArgumentException::class.java) { RemotePlaybackPolicy.validate(listOf(chapters[0], chapters[1].copy(start = 99.0))) }
        assertThrows(IllegalArgumentException::class.java) { RemotePlaybackPolicy.target(chapters, 0.0, true, "time", Double.NaN, 250.0) }
    }
}

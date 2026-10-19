package app.avid.playback

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class PlaybackEventTailTest {
    private val source = JSONObject().put("accountScope", "account").put("bookId", "book").put("fileId", "audio").put("manifestRevision", "edition")
        .put("url", "https://private.invalid/?token=secret")
    @Test fun `tail is bounded and contains original source anchors without credentials`() {
        val tail = PlaybackEventTail()
        repeat(100) { tail.record(source, "seek", "remote", 90.0, 70.0, 2.0, "paused") }
        val state = tail.snapshot()!!
        assertEquals(64, state.getJSONArray("events").length())
        assertEquals(37, state.getJSONArray("events").getJSONObject(0).getInt("sequence"))
        assertEquals(70.0, state.getJSONArray("events").getJSONObject(63).getDouble("toSourceSeconds"), 0.0)
        assertFalse(state.toString().contains("secret")); assertFalse(state.toString().contains("url"))
        state.getJSONArray("events").getJSONObject(0).put("toSourceSeconds", 0.0)
        assertEquals(70.0, tail.snapshot()!!.getJSONArray("events").getJSONObject(0).getDouble("toSourceSeconds"), 0.0)
    }
    @Test fun `source edition change and process source reset start fresh tails`() {
        val tail = PlaybackEventTail()
        tail.record(source,"play","native-observation",1.0,1.0,1.0,"playing")
        val old = tail.snapshot()!!.getString("ownerId")
        tail.record(JSONObject(source.toString()).put("manifestRevision","other"),"load","source-load",2.0,2.0,1.0,"paused")
        assertNotEquals(old,tail.snapshot()!!.getString("ownerId"))
        assertEquals(1,tail.snapshot()!!.getJSONArray("events").length())
        tail.reset(); assertNull(tail.snapshot())
    }
}

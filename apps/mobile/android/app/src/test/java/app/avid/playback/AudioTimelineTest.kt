package app.avid.playback

import org.junit.Assert.*
import org.junit.Test

class AudioTimelineTest {
    @Test fun boundariesAndClamp() {
        val durations = listOf(60.0, 90.0, 20.0)
        assertEquals(AudioTimeline.Position(1, 0.0), AudioTimeline.locate(durations, 60.0))
        assertEquals(AudioTimeline.Position(1, 15.0), AudioTimeline.locate(durations, 75.0))
        assertEquals(AudioTimeline.Position(2, 20.0), AudioTimeline.locate(durations, 999.0))
        assertEquals(AudioTimeline.Position(0, 0.0), AudioTimeline.locate(durations, -1.0))
        assertEquals(150.0, AudioTimeline.start(durations, 2), 0.0)
    }
    @Test fun unknownFinalDurationIsSafe() {
        assertEquals(AudioTimeline.Position(1, 900.0), AudioTimeline.locate(listOf(60.0, null), 960.0))
    }
    @Test(expected = IllegalArgumentException::class) fun unknownMiddleDurationIsRejected() {
        AudioTimeline.locate(listOf(null, 60.0), 30.0)
    }
    @Test(expected = IllegalArgumentException::class) fun nonfiniteDurationIsRejected() {
        AudioTimeline.validate(listOf(Double.NaN))
    }
}

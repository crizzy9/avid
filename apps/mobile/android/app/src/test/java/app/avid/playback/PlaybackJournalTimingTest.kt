package app.avid.playback

import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackJournalTimingTest {
    @Test fun countsListeningTimeAtDifferentPlaybackRates() {
        assertEquals(1.0, JournalPlaybackTiming.interval(1.0, 2.0, 2.0), 0.000001)
        assertEquals(1.0, JournalPlaybackTiming.interval(1.0, 0.5, 0.5), 0.000001)
        assertEquals(0.25, JournalPlaybackTiming.interval(0.25, 0.375, 1.5), 0.000001)
    }
    @Test fun excludesForwardAndBackwardSeekDiscontinuities() {
        assertEquals(0.0, JournalPlaybackTiming.interval(0.25, 30.25, 1.0), 0.0)
        assertEquals(0.0, JournalPlaybackTiming.interval(0.25, -29.75, 1.0), 0.0)
    }
    @Test fun excludesBufferingAndUnobservedLongGaps() {
        assertEquals(0.0, JournalPlaybackTiming.interval(0.25, 0.0, 1.0), 0.0)
        assertEquals(0.0, JournalPlaybackTiming.interval(60.0, 60.0, 1.0), 0.0)
    }
    @Test fun rejectsInvalidClocksPositionsAndRates() {
        assertEquals(0.0, JournalPlaybackTiming.interval(-1.0, 1.0, 1.0), 0.0)
        assertEquals(0.0, JournalPlaybackTiming.interval(Double.NaN, 1.0, 1.0), 0.0)
        assertEquals(0.0, JournalPlaybackTiming.interval(1.0, Double.POSITIVE_INFINITY, 1.0), 0.0)
        assertEquals(0.0, JournalPlaybackTiming.interval(1.0, 1.0, 0.0), 0.0)
    }
}

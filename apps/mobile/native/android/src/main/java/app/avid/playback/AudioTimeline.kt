package app.avid.playback

/** All public positions are source seconds across an ordered, edition-specific timeline. */
object AudioTimeline {
    data class Position(val index: Int, val offset: Double)
    fun validate(durations: List<Double?>) {
        require(durations.isNotEmpty()) { "An audio timeline needs tracks." }
        durations.forEachIndexed { index, duration ->
            require((index == durations.lastIndex || duration != null) && (duration == null || duration.isFinite() && duration > 0)) {
                "Every nonfinal track requires a positive duration."
            }
        }
    }
    fun locate(durations: List<Double?>, seconds: Double): Position {
        validate(durations)
        require(seconds.isFinite())
        var remaining = seconds.coerceAtLeast(0.0)
        durations.forEachIndexed { index, duration ->
            if (duration == null || remaining < duration || index == durations.lastIndex)
                return Position(index, if (duration == null) remaining else remaining.coerceAtMost(duration))
            remaining -= duration
        }
        error("Empty timeline")
    }
    fun start(durations: List<Double?>, index: Int): Double = durations.take(index).sumOf { it ?: 0.0 }
}

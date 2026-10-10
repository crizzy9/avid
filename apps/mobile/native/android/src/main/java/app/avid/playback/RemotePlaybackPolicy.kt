package app.avid.playback

internal data class AudioChapter(val id: String, val title: String, val start: Double, val duration: Double)
internal object RemotePlaybackPolicy {
    fun validate(chapters: List<AudioChapter>) {
        require(chapters.size <= 10000 && chapters.map { it.id }.toSet().size == chapters.size)
        chapters.forEachIndexed { index, chapter ->
            require(chapter.id.length in 1..2048 && chapter.title.length <= 2048 && chapter.start.isFinite() && chapter.duration.isFinite() &&
                chapter.start >= 0 && chapter.duration > 0 && (chapter.start + chapter.duration).isFinite() &&
                (index == 0 || chapter.start >= chapters[index - 1].start + chapters[index - 1].duration)) { "Audio chapters must be finite, ordered, and non-overlapping." }
        }
    }
    fun chapter(chapters: List<AudioChapter>, position: Double) = chapters.indexOfFirst { position >= it.start && position < it.start + it.duration }
    fun target(chapters: List<AudioChapter>, position: Double, forward: Boolean, mode: String, seconds: Double, duration: Double): Double {
        require(mode in setOf("time", "chapter") && seconds.isFinite() && seconds in 1.0..300.0 && position.isFinite())
        val index = chapters.indexOfLast { position >= it.start }
        val result = if (mode == "chapter" && chapters.isNotEmpty()) {
            if (forward) chapters.getOrNull(index + 1)?.start ?: position + seconds
            else if (index >= 0 && position - chapters[index].start > 3) chapters[index].start
            else chapters.getOrNull((index - 1).coerceAtLeast(0))?.start ?: 0.0
        } else position + if (forward) seconds else -seconds
        return result.coerceAtLeast(0.0).let { if (duration > 0) it.coerceAtMost(duration) else it }
    }
}

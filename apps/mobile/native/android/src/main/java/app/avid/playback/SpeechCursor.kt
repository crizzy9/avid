package app.avid.playback

internal data class SpeechPart(val start: Int, val text: String)
internal data class SpeechAttempt(val generation: Long, val id: String, val text: String, val parts: List<SpeechPart>,
    var index: Int = 0, var startedAt: Long? = null) {
    val engineId get() = "avid-speech-$generation:$index"
}

/** UTF-16 offsets are preserved across an engine's smaller input limit and stale callbacks. */
internal class SpeechCursor {
    private var generation = 0L
    var active: SpeechAttempt? = null
        private set
    fun begin(id: String, text: String, engineLimit: Int): SpeechAttempt {
        require(id.length in 1..128 && text.isNotBlank() && text.length <= 4096 && engineLimit >= 2)
        val parts = mutableListOf<SpeechPart>()
        var start = 0
        while (start < text.length) {
            var end = minOf(text.length, start + engineLimit)
            if (end < text.length) {
                if (text[end - 1].isHighSurrogate() && text[end].isLowSurrogate()) end--
                val space = (end - 1 downTo start + (end - start) / 2).firstOrNull { text[it].isWhitespace() }
                if (space != null) end = space + 1
            }
            parts.add(SpeechPart(start, text.substring(start, end)))
            start = end
        }
        return SpeechAttempt(++generation, id, text, parts).also { active = it }
    }
    fun matching(engineId: String?) = active?.takeIf { it.engineId == engineId }
    fun cancel(id: String? = null): Boolean {
        if (id != null && active?.id != id) return false
        active = null
        return true
    }
    fun range(engineId: String?, start: Int, end: Int): IntRange? {
        val attempt = matching(engineId) ?: return null
        val part = attempt.parts[attempt.index]
        if (start < 0 || end <= start || end > part.text.length) return null
        fun splitsPair(index: Int) = index > 0 && index < part.text.length && part.text[index - 1].isHighSurrogate() && part.text[index].isLowSurrogate()
        if (splitsPair(start) || splitsPair(end)) return null
        return (part.start + start) until (part.start + end)
    }
}

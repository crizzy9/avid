package app.avid.playback

import java.net.URI
import java.util.ArrayDeque

internal object AuthPolicy {
    fun server(raw: String): String {
        require(raw.length in 1..8192)
        val uri = URI(raw)
        require(uri.scheme in listOf("https", "http") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null)
        require(uri.normalize().rawPath == uri.rawPath && !uri.rawPath.contains(Regex("(?i)%2e|%2f|%5c")))
        return raw.trimEnd('/').removeSuffix("/api/v1")
    }
    fun protectedMedia(raw: String, server: String): Boolean = try {
        val source = URI(raw); val base = URI(AuthPolicy.server(server))
        fun port(uri: URI) = if (uri.port >= 0) uri.port else if (uri.scheme == "https") 443 else 80
        source.rawUserInfo == null && source.rawFragment == null && source.scheme == base.scheme && source.host == base.host &&
            port(source) == port(base) && source.rawPath.startsWith("${base.rawPath.trimEnd('/')}/api/") &&
            source.normalize().rawPath == source.rawPath && !source.rawPath.contains(Regex("(?i)%2e|%2f|%5c"))
    } catch (_: Exception) { false }
    fun needsRefresh(expiresAtSeconds: Double?, nowMillis: Long): Boolean =
        expiresAtSeconds == null || !expiresAtSeconds.isFinite() || expiresAtSeconds * 1000 <= nowMillis + 90_000
    fun owns(expectedGeneration: String, generation: String, requestedScope: String, currentScope: String): Boolean =
        expectedGeneration.isNotBlank() && expectedGeneration == generation && requestedScope.isNotBlank() && requestedScope == currentScope
    fun verifiedUser(expected: String, actual: String, active: Boolean): Boolean = expected.isNotBlank() && expected == actual && active
}

/** Only short cookie/vault commits enter this queue; network waits never block logout. */
internal class AuthCommitQueue(private val dispatch: (() -> Unit) -> Unit) {
    private val waiting = ArrayDeque<(() -> Unit) -> Unit>()
    private var running = false
    fun submit(operation: (() -> Unit) -> Unit) = dispatch {
        waiting.add(operation)
        next()
    }
    private fun next() {
        if (running || waiting.isEmpty()) return
        running = true
        var complete = false
        val done = {
            dispatch {
                if (!complete) { complete = true; running = false; next() }
            }
        }
        try { waiting.removeFirst()(done) } catch (error: Exception) { done(); throw error }
    }
}

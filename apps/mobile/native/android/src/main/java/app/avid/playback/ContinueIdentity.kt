package app.avid.playback

import java.net.URI
import java.security.MessageDigest

/** The public link contains a digest only; navigation always requires a current-account catalog lookup. */
internal object ContinueIdentity {
    val kinds = setOf("epub", "pdf", "comic", "audio")
    fun hash(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
    fun account(server: String, user: String): String = hash("${server.length}:$server${user.length}:$user")
    fun identifier(scopeHash: String, bookId: String, fileId: String): String =
        hash("${scopeHash.length}:$scopeHash${bookId.length}:$bookId${fileId.length}:$fileId")
    fun linkIdentifier(raw: String): String? = try {
        val uri = URI(raw)
        if (raw.length > 256 || raw.substringBefore('?') != "avid://resume" || uri.rawFragment != null ||
            uri.rawUserInfo != null || uri.rawQuery?.matches(Regex("identifier=[0-9a-f]{64}")) != true) null
        else uri.rawQuery.removePrefix("identifier=")
    } catch (_: Exception) { null }
    fun permits(activeAccount: String?, storedAccount: String, scopeHash: String, identifier: String,
                bookId: String, fileId: String, kind: String): Boolean =
        activeAccount != null && activeAccount == storedAccount && scopeHash.matches(Regex("[0-9a-f]{64}")) &&
            bookId.isNotBlank() && fileId.isNotBlank() && kind in kinds && identifier == ContinueIdentity.identifier(scopeHash, bookId, fileId)
}

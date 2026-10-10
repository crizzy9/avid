package app.avid.playback

import java.net.URI
import java.net.URLDecoder
import java.security.MessageDigest

/** Pure URL binding rules shared by the encrypted transaction store and JVM tests. */
internal object OidcBinding {
    const val REDIRECT = "avid://oauth2-callback"
    private val secret = Regex("^[A-Za-z0-9_-]{43}$")
    fun validSecret(value: String): Boolean = secret.matches(value)
    fun validWindow(createdAt: Double, expiresAt: Double, now: Double): Boolean =
        createdAt.isFinite() && expiresAt.isFinite() && now.isFinite() && createdAt > 0 &&
            now >= createdAt && now < expiresAt && expiresAt > createdAt && expiresAt - createdAt <= 300_000
    fun httpUrl(raw: String, allowQuery: Boolean = true): URI {
        require(raw.length in 1..8192)
        val uri = URI(raw)
        require(uri.scheme in listOf("http", "https") && !uri.host.isNullOrBlank() && uri.rawUserInfo == null && uri.rawFragment == null)
        require(allowQuery || uri.rawQuery == null)
        return uri
    }
    private fun parameters(uri: URI): Map<String, String> {
        val values = linkedMapOf<String, String>()
        for (entry in (uri.rawQuery ?: "").split('&').filter { it.isNotEmpty() }) {
            val pieces = entry.split('=', limit = 2)
            val name = URLDecoder.decode(pieces[0], "UTF-8")
            val value = URLDecoder.decode(pieces.getOrElse(1) { "" }, "UTF-8")
            require(name.isNotEmpty() && !values.containsKey(name))
            values[name] = value
        }
        return values
    }
    private fun single(values: Map<String, String>, name: String, max: Int, required: Boolean = true): String? {
        val value = values[name]
        require((value != null || !required) && (value == null || value.length in 1..max))
        return value
    }
    fun callbackMatches(raw: String, state: String): Boolean = try {
        require(raw.length in 1..8192 && raw.substringBefore('?') == REDIRECT)
        val uri = URI(raw)
        require(uri.rawFragment == null && uri.rawUserInfo == null)
        val values = parameters(uri)
        require(single(values, "state", 512) == state)
        val error = single(values, "error", 512, false)
        val code = single(values, "code", 2048, error == null)
        require(error == null || code == null)
        single(values, "error_description", 2048, false)
        true
    } catch (_: Exception) { false }

    fun challenge(verifier: String): String {
        require(validSecret(verifier))
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val bytes = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return buildString {
            var buffer = 0; var bits = 0
            for (byte in bytes) {
                buffer = (buffer shl 8) or (byte.toInt() and 255); bits += 8
                while (bits >= 6) { bits -= 6; append(alphabet[(buffer ushr bits) and 63]) }
            }
            if (bits > 0) append(alphabet[(buffer shl (6 - bits)) and 63])
        }
    }
    fun authorization(raw: String, state: String, nonce: String, verifier: String): URI {
        val uri = httpUrl(raw)
        val values = parameters(uri)
        require(!values.containsKey("code_verifier"))
        require(single(values, "state", 512) == state && single(values, "nonce", 43) == nonce)
        require(single(values, "redirect_uri", 2048) == REDIRECT && single(values, "response_type", 32) == "code")
        require(single(values, "response_mode", 32) == "query")
        require(single(values, "code_challenge_method", 16) == "S256" && single(values, "code_challenge", 43) == challenge(verifier))
        single(values, "client_id", 512)
        require(single(values, "scope", 2048)!!.split(Regex("\\s+")).contains("openid"))
        return uri
    }
}

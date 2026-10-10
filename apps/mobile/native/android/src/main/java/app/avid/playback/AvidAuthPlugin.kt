package app.avid.playback

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.security.NetworkSecurityPolicy
import android.util.Base64
import android.webkit.CookieManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Shared by foreground API calls and the background player. No request mutates a global cookie jar. */
internal object AvidAuth {
    private val main = Handler(Looper.getMainLooper())
    private val commits = AuthCommitQueue { main.post(it) }
    private val network = Executors.newCachedThreadPool()
    private val requests = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val observers = mutableSetOf<(String, String) -> Unit>()
    private val client = IsolatedHttp.client()
    private const val FAILURE = "Your BookOrbit session could not be renewed. Reconnect to continue protected audio."
    private fun failed(error: Throwable) = CompletableFuture<JSONObject>().apply { completeExceptionally(error) }
    fun scope(session: JSONObject): String = JSONArray(listOf(AuthPolicy.server(session.getJSONObject("profile").getString("url")), session.getString("userId")))
        .toString().replace("\\/", "/")
    private fun requireScope(requested: String, session: JSONObject) {
        require(requested.length in 1..8192)
        val parts = JSONArray(requested)
        require(parts.length() == 2 && parts.get(0) is String && parts.get(1) is String &&
            parts.getString(0) == AuthPolicy.server(session.getJSONObject("profile").getString("url")) && parts.getString(1) == session.getString("userId"))
    }
    fun isCurrent(context: Context, accountScope: String): Boolean = try {
        requireScope(accountScope, AvidSessionStore.read(context).getJSONObject("session")); true
    } catch (_: Exception) { false }
    fun tokenNeedsRefresh(session: JSONObject): Boolean {
        // JWT exp is a scheduling hint only. /auth/me is the authority for every rotated credential.
        val expiry = try {
            val parts = session.getString("accessToken").split('.')
            require(parts.size == 3 && parts[1].length <= 32768)
            JSONObject(String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)).getDouble("exp")
        } catch (_: Exception) { null }
        return AuthPolicy.needsRefresh(expiry, System.currentTimeMillis())
    }
    fun observe(callback: (String, String) -> Unit): () -> Unit {
        synchronized(observers) { observers.add(callback) }
        return { synchronized(observers) { observers.remove(callback) }; Unit }
    }
    private fun changed(record: JSONObject, accountScope: String) {
        synchronized(observers) { observers.toList() }.forEach { observer -> runCatching { observer(record.getString("generation"), accountScope) } }
    }
    private data class Reply(val status: Int, val body: Any, val cookies: List<String>, val url: String)
    private fun request(url: String, body: String? = null, bearer: String? = null, cookies: String? = null): Reply {
        val parsed = url.toHttpUrl()
        require(parsed.isHttps || NetworkSecurityPolicy.getInstance().isCleartextTrafficPermitted(parsed.host))
        val builder = Request.Builder().url(parsed).header("Accept", "application/json")
        if (body != null) builder.post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
        if (bearer != null) builder.header("Authorization", "Bearer $bearer")
        if (!cookies.isNullOrBlank()) builder.header("Cookie", cookies)
        return client.newCall(builder.build()).execute().use { response ->
            val source = response.body?.source()
            val bytes = source?.inputStream()?.use { stream ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = stream.read(buffer)
                    if (count == -1) break
                    require(output.size() + count <= 1_048_576) { "Authentication response is too large." }
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: ByteArray(0)
            val value = if (bytes.isEmpty()) JSONObject.NULL else try { JSONTokener(String(bytes, Charsets.UTF_8)).nextValue() }
                catch (_: Exception) { JSONObject().put("message", "BookOrbit request failed (${response.code}).") }
            val staged = response.headers.values("Set-Cookie").filter { line ->
                require(line.length <= 16384)
                val cookie = Cookie.parse(parsed, line)
                cookie != null && cookie.domain == parsed.host && cookie.name in setOf("access_token", "refresh_token") && cookie.matches(parsed)
            }
            require(staged.size <= 16)
            Reply(response.code, value, staged, url)
        }
    }
    private fun applyCookies(url: String, values: List<String>, complete: (Exception?) -> Unit) {
        if (values.isEmpty()) { complete(null); return }
        val manager = CookieManager.getInstance()
        fun next(index: Int) {
            try {
                if (index == values.size) { manager.flush(); complete(null); return }
                manager.setCookie(url, values[index]) { accepted ->
                    if (!accepted) complete(IOException("The secure cookie store rejected refreshed credentials."))
                    else next(index + 1)
                }
            } catch (error: Exception) { complete(error) }
        }
        next(0)
    }
    private fun requireCredentialCookies(reply: Reply) {
        val cookies = reply.cookies.mapNotNull { Cookie.parse(reply.url.toHttpUrl(), it) }
        require(listOf("access_token", "refresh_token").all { name -> cookies.any { it.name == name && it.value.isNotBlank() && it.expiresAt > System.currentTimeMillis() } })
    }
    /** Shared generation barrier used by the AvidSession bridge; it waits for cookie callbacks, never HTTP. */
    fun write(context: Context, expected: String, session: JSONObject, readOnly: Boolean): CompletableFuture<JSONObject> {
        val future = CompletableFuture<JSONObject>()
        commits.submit { done ->
            try {
                val prior = AvidSessionStore.read(context).optJSONObject("session")
                require(prior == null || scope(prior) == scope(session)) { "Clear the previous account before replacing it." }
                val saved = AvidSessionStore.write(context, expected, session, readOnly)
                runCatching { AvidContinueWidget.refresh(context) }
                future.complete(saved)
            }
            catch (error: Exception) { future.completeExceptionally(error) }
            finally { done() }
        }
        return future
    }
    fun clear(context: Context, expected: String?): CompletableFuture<JSONObject> {
        val future = CompletableFuture<JSONObject>()
        commits.submit { done ->
            try {
                if (expected != null) require(AvidSessionStore.read(context).getString("generation") == expected)
                val clearedScope = AvidSessionStore.read(context).optJSONObject("session")?.let { scope(it) } ?: MediaTransferStore.DEMO_SCOPE
                // Stop protected sources before replacing cookies. A late network response will fail CAS.
                runCatching { AvidPlaybackJournal.flush() }
                AvidAudioCatalog.initialize(context); AvidAudioCatalog.clear()
                runCatching { AvidContinueStore.clear(context); AvidContinueWidget.refresh(context) }
                val cleared = AvidSessionStore.clear(context, expected)
                runCatching { AvidMediaStore.clearScope(context, clearedScope); AvidArtwork.clearScope(context, clearedScope) }
                val manager = CookieManager.getInstance()
                manager.removeAllCookies {
                    try {
                        manager.flush()
                        runCatching { AvidContinueWidget.refresh(context) }
                        future.complete(cleared)
                    }
                    catch (error: Exception) { future.completeExceptionally(error) }
                    finally { done() }
                }
            } catch (error: Exception) { future.completeExceptionally(error); done() }
        }
        return future
    }
    fun authenticate(context: Context, expected: String, server: String, path: String, body: String): CompletableFuture<JSONObject> {
        val future = CompletableFuture<JSONObject>()
        commits.submit { done ->
            try {
                require(path in setOf("login", "oidc/callback") && body.length in 1..262144)
                val payload = JSONObject(body)
                require(payload.optString("clientKind", "web") == "web")
                val current = AvidSessionStore.read(context)
                require(current.getString("generation") == expected && current.optJSONObject("session") == null)
                val url = "${AuthPolicy.server(server)}/api/v1/auth/$path"
                network.execute {
                    try {
                        val response = request(url, body)
                        commits.submit { finish ->
                            try {
                                val saved = AvidSessionStore.read(context)
                                require(saved.getString("generation") == expected && saved.optJSONObject("session") == null)
                                val result = JSONObject().put("status", response.status).put("body", response.body)
                                if (response.status !in 200..299) { future.complete(result); finish() }
                                else {
                                    val auth = response.body as? JSONObject ?: error("Invalid sign-in response.")
                                    require(auth.optString("accessToken").isNotBlank() && auth.optJSONObject("user") != null)
                                    requireCredentialCookies(response)
                                    applyCookies(url, response.cookies) { error ->
                                        if (error == null) future.complete(result) else future.completeExceptionally(error)
                                        finish()
                                    }
                                }
                            } catch (error: Exception) { future.completeExceptionally(error); finish() }
                        }
                    } catch (error: Exception) { future.completeExceptionally(error) }
                }
            } catch (error: Exception) { future.completeExceptionally(error) }
            finally { done() }
        }
        return future
    }
    fun refresh(context: Context, requestedScope: String, expected: String? = null, force: Boolean = false): CompletableFuture<JSONObject> {
        val future = CompletableFuture<JSONObject>()
        // A fresh vault token is not usable by media until its staged cookie callbacks have finished.
        // Queue the initial read/fast path too, not only the eventual rotation commit.
        commits.submit { done ->
            try {
                preparedRefresh(context, requestedScope, expected, force).whenComplete { value, error ->
                    if (error == null) future.complete(value) else future.completeExceptionally(error)
                }
            } catch (error: Exception) { future.completeExceptionally(error) }
            finally { done() }
        }
        return future
    }
    private fun preparedRefresh(context: Context, requestedScope: String, expected: String?, force: Boolean): CompletableFuture<JSONObject> {
        val captured = try {
            val record = AvidSessionStore.read(context)
            require(expected == null || record.getString("generation") == expected)
            requireScope(requestedScope, record.getJSONObject("session"))
            JSONObject(record.toString())
        } catch (error: Exception) { return failed(error) }
        val generation = captured.getString("generation")
        val identity = scope(captured.getJSONObject("session"))
        val key = "$identity:$generation"
        requests[key]?.let { return it }
        if (!force && !tokenNeedsRefresh(captured.getJSONObject("session"))) return CompletableFuture.completedFuture(captured)
        val future = CompletableFuture<JSONObject>()
        requests.putIfAbsent(key, future)?.let { return it }
        future.whenComplete { _, _ -> requests.remove(key, future) }
        commits.submit { done ->
            try {
                val current = AvidSessionStore.read(context)
                require(AuthPolicy.owns(generation, current.getString("generation"), identity, scope(current.getJSONObject("session"))))
                val session = captured.getJSONObject("session")
                val native = session.optString("clientKind", "web") == "native"
                val url = "${AuthPolicy.server(session.getJSONObject("profile").getString("url"))}/api/v1/auth/refresh"
                val cookie = if (native) null else CookieManager.getInstance().getCookie(url)
                val payload = if (native) JSONObject().put("refreshToken", session.getString("refreshToken")).toString() else "{}"
                require(native || !cookie.isNullOrBlank())
                network.execute {
                    try {
                        val response = request(url, payload, cookies = cookie)
                        require(response.status in 200..299) { FAILURE }
                        if (!native) requireCredentialCookies(response)
                        val tokens = response.body as? JSONObject ?: error(FAILURE)
                        val token = tokens.getString("accessToken"); require(token.isNotBlank() && token.length <= 131072)
                        val me = request(url.removeSuffix("refresh") + "me", bearer = token)
                        val user = me.body as? JSONObject ?: error(FAILURE)
                        require(me.status in 200..299 && AuthPolicy.verifiedUser(session.getString("userId"), user.get("id").toString(), user.opt("active") == true)) { FAILURE }
                        val candidate = JSONObject(session.toString()).put("accessToken", token)
                        if (native) {
                            val refresh = tokens.getString("refreshToken"); require(refresh.isNotBlank() && refresh.length <= 131072)
                            candidate.put("refreshToken", refresh)
                        }
                        commits.submit { finish ->
                            try {
                                val saved = AvidSessionStore.read(context)
                                require(AuthPolicy.owns(generation, saved.getString("generation"), identity, scope(saved.getJSONObject("session"))))
                                // Persist first. A failed durable write must not rotate global cookies.
                                val updated = AvidSessionStore.write(context, generation, candidate, captured.optBoolean("readOnly", true))
                                applyCookies(url, if (native) emptyList() else response.cookies) { error ->
                                    try {
                                        if (error != null) throw error
                                        runCatching { AvidContinueWidget.refresh(context) }
                                        future.complete(updated)
                                        changed(updated, identity)
                                    } catch (failure: Exception) { future.completeExceptionally(failure) }
                                    finally { finish() }
                                }
                            } catch (error: Exception) { future.completeExceptionally(error); finish() }
                        }
                    } catch (error: Exception) { future.completeExceptionally(error) }
                }
            } catch (error: Exception) { future.completeExceptionally(error) }
            finally { done() }
        }
        return future
    }
}

@CapacitorPlugin(name = "AvidAuth")
class AvidAuthPlugin : Plugin() {
    private var stopObserver: (() -> Unit)? = null
    override fun load() {
        stopObserver = AvidAuth.observe { generation, scope ->
            notifyListeners("sessionChanged", JSObject().put("generation", generation).put("accountScope", scope), true)
        }
    }
    private fun resolve(call: PluginCall, future: CompletableFuture<JSONObject>) {
        future.whenComplete { record, error ->
            if (error == null) call.resolve(JSObject(record.toString()))
            else call.reject("Secure authentication failed or the active account changed. Reconnect to continue.")
        }
    }
    @PluginMethod fun authenticate(call: PluginCall) = resolve(call, AvidAuth.authenticate(context,
        call.getString("expectedGeneration") ?: "", call.getString("serverUrl") ?: "", call.getString("path") ?: "", call.getString("body") ?: ""))
    @PluginMethod fun refresh(call: PluginCall) = resolve(call, AvidAuth.refresh(context,
        call.getString("accountScope") ?: "", call.getString("expectedGeneration"), call.getBoolean("force") ?: false))
    override fun handleOnDestroy() { stopObserver?.invoke(); stopObserver = null; super.handleOnDestroy() }
}

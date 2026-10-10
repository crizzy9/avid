package app.avid.playback

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.AtomicFile
import android.util.Base64
import android.webkit.CookieManager
import okhttp3.Request
import org.json.JSONArray
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Only downsampled image bytes are cached. Remote/signed/blob URLs never reach disk. */
internal object AvidArtwork {
    private const val MAX_DOWNLOAD = 2 * 1024 * 1024
    private const val MAX_IMAGE = 96 * 1024
    private const val MAX_FILES = 64
    private val worker = ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(4), ThreadPoolExecutor.DiscardOldestPolicy())
    private val requests = ConcurrentHashMap<String, String>()
    @Volatile var revision = 0L; private set
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun key(scope: String, book: String, file: String) = "${hash(scope)}-${hash(JSONArray(listOf(book, file)).toString())}"
    private fun directory(context: Context) = File(context.noBackupFilesDir, "avid-artwork").apply { mkdirs() }
    fun read(context: Context, scope: String, book: String, file: String): ByteArray? = runCatching {
        val image = File(directory(context), "${key(scope, book, file)}.jpg")
        if (image.length() in 1..MAX_IMAGE) image.readBytes() else null
    }.getOrNull()
    fun fetch(context: Context, scope: String, book: String, file: String, url: String) {
        val app = context.applicationContext
        val dataPrefix = Regex("^data:image/(jpeg|png|webp);base64,").find(url)?.value
        val embedded = if (dataPrefix != null) runCatching {
            val encoded = url.substring(dataPrefix.length)
            require(encoded.length in 1..((MAX_DOWNLOAD + 2) / 3 * 4) && encoded.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
            Base64.decode(encoded, Base64.NO_WRAP).also { require(it.size <= MAX_DOWNLOAD) }
        }.getOrNull() ?: return else null
        if (embedded == null) {
            if (url.length > 8192) return
            val uri = runCatching { URI(url) }.getOrNull() ?: return
            if (uri.scheme !in setOf("https", "http") || uri.host.isNullOrBlank() || uri.rawUserInfo != null) return
        }
        val initial = runCatching { AvidMediaStore.account(app) }.getOrNull() ?: return
        if (!MediaTransferStore.allowed(scope, initial)) return
        val cacheKey = key(scope, book, file); val ticket = UUID.randomUUID().toString()
        if (requests.size >= MAX_FILES) requests.clear()
        requests[cacheKey] = ticket
        worker.execute {
            runCatching {
                if (requests[cacheKey] != ticket) return@runCatching
                var expected = initial
                val raw = embedded ?: run {
                    val builder = Request.Builder().url(url)
                    val server = runCatching { JSONArray(scope).getString(0) }.getOrNull()
                    if (server != null && AuthPolicy.protectedMedia(url, server)) {
                        val record = AvidAuth.refresh(app, scope, initial.generation).get(65, TimeUnit.SECONDS)
                        expected = MediaAccount(record.getString("generation"), scope)
                        builder.header("Authorization", "Bearer ${record.getJSONObject("session").getString("accessToken")}")
                        CookieManager.getInstance().getCookie(url)?.let { builder.header("Cookie", it) }
                    }
                    IsolatedHttp.client().newCall(builder.build()).execute().use { response ->
                        require(response.isSuccessful)
                        val body = response.body ?: error("No artwork")
                        require(body.contentLength() <= MAX_DOWNLOAD)
                        body.byteStream().use { stream ->
                            val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                            while (true) { val count = stream.read(buffer); if (count < 0) break; require(output.size() + count <= MAX_DOWNLOAD); output.write(buffer, 0, count) }
                            output.toByteArray()
                        }
                    }
                }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
                require(bounds.outWidth in 1..8192 && bounds.outHeight in 1..8192 && bounds.outWidth.toLong() * bounds.outHeight <= 16_777_216)
                var sample = 1
                while (bounds.outWidth / sample > 512 || bounds.outHeight / sample > 512) sample *= 2
                var bitmap = BitmapFactory.decodeByteArray(raw, 0, raw.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: error("Invalid artwork")
                val output = ByteArrayOutputStream()
                try {
                    bitmap.compress(Bitmap.CompressFormat.JPEG, 80, output)
                    if (output.size() > MAX_IMAGE) {
                        val scaled = Bitmap.createScaledBitmap(bitmap, (bitmap.width / 2).coerceAtLeast(1), (bitmap.height / 2).coerceAtLeast(1), true)
                        bitmap.recycle(); bitmap = scaled; output.reset(); bitmap.compress(Bitmap.CompressFormat.JPEG, 65, output)
                    }
                } finally { bitmap.recycle() }
                require(output.size() in 1..MAX_IMAGE)
                synchronized(AvidSessionStore) {
                    require(AvidMediaStore.account(app) == expected && requests[cacheKey] == ticket)
                    val folder = directory(app)
                    val target = AtomicFile(File(folder, "$cacheKey.jpg")); val stream = target.startWrite()
                    try { stream.write(output.toByteArray()); target.finishWrite(stream) } catch (error: Exception) { target.failWrite(stream); throw error }
                    folder.listFiles().orEmpty().filter { it.name.endsWith(".jpg") }.sortedByDescending { it.lastModified() }.drop(MAX_FILES).forEach { it.delete() }
                    revision++
                }
            }
            requests.remove(cacheKey, ticket)
        }
    }
    fun clearScope(context: Context, scope: String) = synchronized(AvidSessionStore) {
        val prefix = "${hash(scope)}-"
        requests.keys.filter { it.startsWith(prefix) }.forEach { requests.remove(it) }
        directory(context).listFiles().orEmpty().filter { it.name.startsWith(prefix) }.forEach { it.delete() }
        revision++
    }
}

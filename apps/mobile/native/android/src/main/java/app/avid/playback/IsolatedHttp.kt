package app.avid.playback

import okhttp3.CookieJar
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/** Explicit cookies only. A cancelled account's response can never write a process-wide cookie jar. */
internal object IsolatedHttp {
    fun client(callTimeoutSeconds: Long = 30): OkHttpClient = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(callTimeoutSeconds, TimeUnit.SECONDS).build()
}

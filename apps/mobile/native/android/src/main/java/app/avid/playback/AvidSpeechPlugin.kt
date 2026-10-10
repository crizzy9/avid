package app.avid.playback

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.util.Locale
import java.util.concurrent.CompletableFuture

/** Native synthesis for one bounded utterance. Chapter traversal remains with the foreground reader. */
@CapacitorPlugin(name = "AvidSpeech")
class AvidSpeechPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private val ready = CompletableFuture<TextToSpeech>()
    private val cursor = SpeechCursor()
    private var engine: TextToSpeech? = null
    private var destroyed = false
    private var focusRequest: AudioFocusRequest? = null
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val audio get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
    override fun load() {
        main.post {
            try {
                engine = TextToSpeech(context.applicationContext) { status ->
                    main.post {
                        val speech = engine
                        try {
                            require(!destroyed && status == TextToSpeech.SUCCESS && speech != null)
                            require(speech.setAudioAttributes(attributes) == TextToSpeech.SUCCESS)
                            require(speech.setOnUtteranceProgressListener(progress) == TextToSpeech.SUCCESS)
                            ready.complete(speech)
                        } catch (error: Exception) { ready.completeExceptionally(error) }
                    }
                }
            } catch (error: Exception) { ready.completeExceptionally(error) }
        }
    }
    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) { main.post {
            cursor.matching(utteranceId)?.let { attempt ->
                if (attempt.startedAt == null) { attempt.startedAt = SystemClock.elapsedRealtime(); emit(attempt, "start") }
            }
        } }
        override fun onDone(utteranceId: String?) { main.post {
            val attempt = cursor.matching(utteranceId) ?: return@post
            if (attempt.index + 1 < attempt.parts.size) { attempt.index++; dispatch(attempt, first = false) }
            else { cursor.cancel(attempt.id); abandonFocus(); emit(attempt, "end") }
        } }
        @Deprecated("Framework compatibility") override fun onError(utteranceId: String?) { reportError(utteranceId) }
        override fun onError(utteranceId: String?, errorCode: Int) { reportError(utteranceId) }
        override fun onStop(utteranceId: String?, interrupted: Boolean) { main.post {
            cursor.matching(utteranceId)?.let { fail(it, "Speech was interrupted.") }
        } }
        // API26+ engines invoke this only when genuine synthesis timing is available.
        override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) { main.post {
            val attempt = cursor.matching(utteranceId) ?: return@post
            val range = cursor.range(utteranceId, start, end) ?: return@post
            emit(attempt, "boundary", range.first, range.last + 1)
        } }
    }
    private fun reportError(engineId: String?) { main.post { cursor.matching(engineId)?.let { fail(it, "The speech engine could not read this text. Check the selected voice and language.") } } }
    private fun emit(attempt: SpeechAttempt, type: String, start: Int? = null, end: Int? = null, message: String? = null) {
        if (destroyed) return
        val value = JSObject().put("id", attempt.id).put("type", type)
        attempt.startedAt?.let { value.put("elapsedTime", (SystemClock.elapsedRealtime() - it).coerceAtLeast(0) / 1000.0) }
        start?.let { value.put("start", it) }; end?.let { value.put("end", it) }; message?.let { value.put("message", it) }
        notifyListeners("speech", value)
    }
    private fun fail(attempt: SpeechAttempt, message: String) {
        if (cursor.active !== attempt) return
        cursor.cancel(attempt.id); runCatching { engine?.stop(); abandonFocus() }; emit(attempt, "error", message = message)
    }
    @Suppress("DEPRECATION") private fun acquireFocus(attempt: SpeechAttempt): Boolean {
        val listener = AudioManager.OnAudioFocusChangeListener { change ->
            if (change < 0) main.post {
                if (cursor.active === attempt) fail(attempt, "Speech was interrupted by another audio session.")
            }
        }
        focusListener = listener
        return if (Build.VERSION.SDK_INT >= 26) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attributes)
                .setOnAudioFocusChangeListener(listener, main).setWillPauseWhenDucked(true).build()
            focusRequest = request
            audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        } else audio.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }
    @Suppress("DEPRECATION") private fun abandonFocus() {
        if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { audio.abandonAudioFocusRequest(it) }
        else focusListener?.let { audio.abandonAudioFocus(it) }
        focusRequest = null; focusListener = null
    }
    private fun dispatch(attempt: SpeechAttempt, first: Boolean): Boolean {
        val result = runCatching { engine?.speak(attempt.parts[attempt.index].text, if (first) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD,
            Bundle(), attempt.engineId) }.getOrNull()
        if (result == TextToSpeech.SUCCESS) return true
        fail(attempt, "The speech engine rejected this utterance.")
        return false
    }
    @PluginMethod fun voices(call: PluginCall) {
        ready.whenComplete { speech, error -> main.post {
            if (destroyed || error != null) call.reject("A native speech engine is unavailable.")
            else try {
                val default = speech.defaultVoice?.name
                val voices = speech.voices.orEmpty().filter { !it.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }.sortedBy { it.name }.map { voice ->
                    JSObject().put("voiceURI", voice.name).put("name", voice.name).put("lang", voice.locale.toLanguageTag())
                        .put("localService", !voice.isNetworkConnectionRequired).put("default", voice.name == default)
                }
                call.resolve(JSObject().put("voices", JSONArray(voices)))
            } catch (_: Exception) { call.reject("The installed speech voices could not be loaded.") }
        } }
    }
    @PluginMethod fun speak(call: PluginCall) {
        main.post {
            val attempt: SpeechAttempt
            val rate = call.getDouble("rate") ?: 1.0
            try {
                require(!destroyed && rate.isFinite() && rate in 0.5..2.0)
                attempt = cursor.begin(call.getString("id") ?: "", call.getString("text") ?: "", minOf(4096, TextToSpeech.getMaxSpeechInputLength()))
                engine?.stop(); abandonFocus()
            } catch (_: Exception) { call.reject("Speech needs an ID, up to 4096 UTF-16 characters, and a rate from 0.5 to 2."); return@post }
            ready.whenComplete { speech, error -> main.post ready@{
                if (destroyed || cursor.active !== attempt) { call.reject("This speech request was cancelled."); return@ready }
                try {
                    if (error != null) throw error
                    val voiceId = call.getString("voiceURI")
                    val language = call.getString("lang")
                    val local = speech.voices.orEmpty().filter { !it.isNetworkConnectionRequired && !it.features.orEmpty().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }.sortedBy { it.name }
                    val voice = if (!voiceId.isNullOrBlank()) local.firstOrNull { it.name == voiceId }
                    else if (!language.isNullOrBlank()) {
                        require(language.length <= 64)
                        val locale = Locale.forLanguageTag(language); require(locale.language.isNotBlank())
                        local.firstOrNull { it.locale.toLanguageTag().equals(locale.toLanguageTag(), true) }
                            ?: local.firstOrNull { it.locale.language == locale.language }
                    } else local.firstOrNull { it.name == speech.defaultVoice?.name }
                        ?: local.firstOrNull { it.locale.language == Locale.getDefault().language } ?: local.firstOrNull()
                    require(voice != null && speech.setVoice(voice) == TextToSpeech.SUCCESS) { "An installed offline voice is required." }
                    require(speech.setSpeechRate(rate.toFloat()) == TextToSpeech.SUCCESS)
                    require(acquireFocus(attempt)) { "Audio focus is unavailable." }
                    if (dispatch(attempt, first = true)) call.resolve() else call.reject("The speech engine rejected this utterance.")
                } catch (_: Exception) { fail(attempt, "The selected speech voice or audio output is unavailable."); call.reject("The selected speech voice or audio output is unavailable.") }
            } }
        }
    }
    @PluginMethod fun cancel(call: PluginCall) { main.post {
        if (cursor.cancel(call.getString("id"))) runCatching { engine?.stop(); abandonFocus() }
        call.resolve()
    } }
    override fun handleOnDestroy() {
        main.post {
            destroyed = true; cursor.cancel(); runCatching { engine?.stop(); engine?.shutdown(); abandonFocus() }; engine = null
            ready.completeExceptionally(IllegalStateException("The speech owner was destroyed."))
        }
        super.handleOnDestroy()
    }
}

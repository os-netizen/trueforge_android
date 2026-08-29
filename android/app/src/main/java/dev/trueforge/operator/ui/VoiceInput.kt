package dev.trueforge.operator.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * On-device dictation for the task field (brief 03 step 4).
 *
 * Voice is an input-surface concern only: the transcript lands in the prompt
 * field, editable, and the user still taps Send. Nothing is auto-submitted —
 * a mis-transcribed command handed straight to an agent that operates the
 * phone would undercut the whole governance story that the approval gate
 * exists to provide.
 *
 * `SpeechRecognizer` is main-thread bound and effectively single-use, so a
 * recognizer is created per dictation session and destroyed when it ends.
 */
class VoiceInputController(private val context: Context) {

    var listening by mutableStateOf(false)
        private set

    /** Last user-facing error, e.g. "Didn't catch that". Cleared on start. */
    var error by mutableStateOf<String?>(null)
        private set

    private var recognizer: SpeechRecognizer? = null

    fun isAvailable(): Boolean = SpeechRecognizer.isRecognitionAvailable(context)

    /**
     * Must be called on the main thread. [onPartial] streams live dictation
     * into the field; [onFinal] delivers the transcript for review.
     */
    fun start(onPartial: (String) -> Unit, onFinal: (String) -> Unit) {
        if (listening) return
        if (!isAvailable()) {
            error = "Speech recognition is unavailable on this device"
            return
        }
        error = null
        destroyRecognizer()
        val instance = SpeechRecognizer.createSpeechRecognizer(context)
        recognizer = instance
        instance.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) { listening = true }
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            // Keep the session active until onResults/onError. Android sends
            // the final transcript after end-of-speech, and restarting here
            // would destroy that still-pending recognizer.
            override fun onEndOfSpeech() {}

            override fun onError(errorCode: Int) {
                listening = false
                error = speechErrorMessage(errorCode)
                destroyRecognizer()
            }

            override fun onResults(results: Bundle?) {
                listening = false
                firstTranscript(results)?.let(onFinal)
                destroyRecognizer()
            }

            override fun onPartialResults(partialResults: Bundle?) {
                firstTranscript(partialResults)?.let(onPartial)
            }

            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        listening = true
        instance.startListening(recognizerIntent(context))
    }

    fun stop() {
        recognizer?.stopListening()
        listening = false
    }

    fun destroy() {
        listening = false
        destroyRecognizer()
    }

    private fun destroyRecognizer() {
        recognizer?.let {
            it.setRecognitionListener(null)
            it.destroy()
        }
        recognizer = null
    }

    private fun firstTranscript(bundle: Bundle?): String? =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
            ?.firstOrNull()
            ?.takeIf { it.isNotBlank() }

    companion object {
        fun recognizerIntent(context: Context): Intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            }

        fun speechErrorMessage(code: Int): String = when (code) {
            SpeechRecognizer.ERROR_NO_MATCH -> "Didn't catch that"
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech heard"
            SpeechRecognizer.ERROR_AUDIO -> "Microphone error"
            SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT ->
                "Speech service unreachable"
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission denied"
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy; try again"
            SpeechRecognizer.ERROR_CLIENT -> "Dictation stopped"
            SpeechRecognizer.ERROR_SERVER -> "Speech service error"
            else -> "Dictation failed (code $code)"
        }
    }
}

package dev.trueforge.operator.networking

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * Resilient WebSocket link to the bridge server (handoff doc section 26):
 * sends hello on connect, forwards inbound wire messages, reconnects with
 * exponential backoff until stopped.
 */
class DeviceConnection(
    private val appContext: Context,
    private val serverUrl: String,
    private val scope: CoroutineScope,
    private val helloJson: () -> String,
    private val onWireMessage: suspend (String) -> String?,
) {
    companion object {
        private const val TAG = "OperatorConn"
        private const val MAX_BACKOFF_MS = 30_000L
    }

    sealed interface State {
        data object Disconnected : State
        data class Connecting(val attempt: Int) : State
        data class Connected(val url: String) : State
    }

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow<State>(State.Disconnected)
    val state: StateFlow<State> = _state

    @Volatile
    private var shouldRun = false

    private var webSocket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var attempt = 0

    fun start() {
        if (shouldRun) return
        shouldRun = true
        attempt = 0
        connect()
    }

    fun stop() {
        shouldRun = false
        reconnectJob?.cancel()
        webSocket?.close(1000, "client stop")
        webSocket = null
        _state.value = State.Disconnected
    }

    fun send(text: String): Boolean =
        webSocket?.send(text) ?: false

    private fun connect() {
        if (!shouldRun) return
        _state.value = State.Connecting(attempt + 1)
        Log.i(TAG, "connecting to $serverUrl (attempt ${attempt + 1})")

        val request = Request.Builder().url(serverUrl).build()
        webSocket = client.newWebSocket(
            request,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (!shouldRun) return
                    attempt = 0
                    this@DeviceConnection.webSocket = webSocket
                    webSocket.send(helloJson())
                    _state.value = State.Connected(serverUrl)
                    Log.i(TAG, "connected; hello sent")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    scope.launch {
                        val reply = onWireMessage(text)
                        if (reply != null && shouldRun && !webSocket.send(reply)) {
                            Log.w(TAG, "failed to send reply")
                        }
                    }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    Log.w(TAG, "connection failed: ${t.message}")
                    scheduleReconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    Log.w(TAG, "closed: $code $reason")
                    if (code != 1000) scheduleReconnect() else _state.value = State.Disconnected
                }
            },
        )
    }

    private fun scheduleReconnect() {
        if (!shouldRun) return
        _state.value = State.Disconnected
        val backoff = minOf(MAX_BACKOFF_MS, 1000L shl attempt.coerceAtMost(5))
        attempt += 1
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(backoff)
            connect()
        }
    }
}

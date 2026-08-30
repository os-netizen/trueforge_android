package dev.trueforge.operator.networking

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.trueforge.operator.R
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.util.DeviceIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * Foreground service hosting the device WebSocket so tasks survive app
 * backgrounding (handoff doc section 41 open decision: resolved as specialUse
 * FGS for the hackathon).
 */
class DeviceConnectionService : Service() {

    companion object {
        const val TAG = "OperatorSvc"
        const val CHANNEL_ID = "operator_connection"
        const val NOTIFICATION_ID = 41
        private const val PREFS = "operator"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val DEFAULT_URL = "ws://100.86.174.95:8792/device"

        /** Latest connection state, shared with UI. */
        val connectionState = MutableStateFlow<DeviceConnection.State?>(null)

        fun serverUrl(context: Context): String =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_SERVER_URL, DEFAULT_URL) ?: DEFAULT_URL

        fun serverUrlDefault(): String = DEFAULT_URL

        fun deviceId(context: Context): String =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_DEVICE_ID, null).let {
                    it ?: DeviceIdentity.deviceId(context).also { id ->
                        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                            .edit().putString(KEY_DEVICE_ID, id).apply()
                    }
                }

        fun saveServerUrl(context: Context, url: String) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_SERVER_URL, url).apply()
        }

        fun start(context: Context) {
            val intent = Intent(context, DeviceConnectionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, DeviceConnectionService::class.java))
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var connection: DeviceConnection? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        promoteForeground("Starting connection")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val url = serverUrl(this)
        val dispatcher by lazy {
            RequestDispatcher(applicationContext) { OperatorAccessibilityService.requireService() }
        }

        connection?.stop()
        val conn = DeviceConnection(
            appContext = applicationContext,
            serverUrl = url,
            scope = scope,
            helloJson = {
                WireJsonClient.json.encodeToString(
                    DeviceHello.serializer(),
                    DeviceHello(
                        deviceId = prefsDeviceId(),
                        model = Build.MODEL,
                        androidVersion = Build.VERSION.RELEASE,
                        accessibilityServiceEnabled = OperatorAccessibilityService.isRunning(),
                    ),
                )
            },
            onWireMessage = { text -> dispatcher.dispatch(text) },
        )
        connection = conn
        scope.launch {
            conn.state.collectLatest { state ->
                Log.i(TAG, "state=$state")
                connectionState.value = state
                updateNotification(state)
            }
        }
        conn.start()
        return START_STICKY
    }

    override fun onDestroy() {
        connection?.stop()
        connection = null
        connectionState.value = null
        scope.cancel()
        super.onDestroy()
    }

    private fun prefsDeviceId(): String = deviceId(this)

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Agent connection",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Shows whether the TrueForge agent can reach this device"
            },
        )
    }

    private fun promoteForeground(text: String) {
        val notification = buildNotification(text)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification(state: DeviceConnection.State) {
        val text = when (state) {
            is DeviceConnection.State.Connected -> "Connected to agent"
            is DeviceConnection.State.Connecting -> "Connecting (attempt ${state.attempt})"
            DeviceConnection.State.Disconnected -> "Disconnected; retrying"
        }
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setOngoing(true)
            .build()
}

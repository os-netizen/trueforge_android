package dev.trueforge.operator

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.networking.DeviceConnection
import dev.trueforge.operator.networking.DeviceConnectionService
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.WireJson
import dev.trueforge.operator.ui.OperatorApp
import dev.trueforge.operator.util.DeviceIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private var serviceRunning by mutableStateOf(false)
    private var serverUrl by mutableStateOf("")
    private var connectionState by mutableStateOf("disconnected")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        serverUrl = DeviceConnectionService.serverUrl(this)

        val permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) connect()
        }

        setContent {
            OperatorApp(
                serviceRunning = serviceRunning,
                serverUrl = serverUrl,
                onServerUrlChange = {
                    serverUrl = it
                    DeviceConnectionService.saveServerUrl(this, it.trim())
                },
                connectionState = connectionState,
                connected = connectionState.startsWith("connected"),
                onConnect = { ensureNotificationPermission(permissionLauncher) },
                onDisconnect = ::disconnect,
                onOpenAccessibilitySettings = ::openAccessibilitySettings,
                onCaptureSnapshot = ::captureSnapshot,
                onClickNode = { nodeId -> actionResultJson { clickNode(nodeId) } },
                onSetText = { nodeId, text -> actionResultJson { setText(nodeId, text) } },
                onGlobalAction = { kind -> actionResultJson { globalAction(kind) } },
            )
        }
    }

    override fun onResume() {
        super.onResume()
        serviceRunning = OperatorAccessibilityService.isRunning()
        observeConnectionState()
    }

    private fun ensureNotificationPermission(launcher: ActivityResultLauncher<String>) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            connect()
        }
    }

    private fun connect() {
        DeviceConnectionService.saveServerUrl(this, serverUrl.trim())
        DeviceConnectionService.start(this)
    }

    private fun disconnect() {
        DeviceConnectionService.stop(this)
    }

    private fun observeConnectionState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                DeviceConnectionService.connectionState.collect { state: DeviceConnection.State? ->
                    connectionState = when (state) {
                        is DeviceConnection.State.Connected -> "connected"
                        is DeviceConnection.State.Connecting ->
                            "connecting (attempt ${(state as DeviceConnection.State.Connecting).attempt})"
                        is DeviceConnection.State.Disconnected -> "disconnected; retrying"
                        null -> "disconnected"
                    }
                    // Refresh accessibility status too, in case it changed.
                    serviceRunning = OperatorAccessibilityService.isRunning()
                }
            }
        }
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun captureSnapshot(): String = try {
        val snapshot = OperatorAccessibilityService.requireService()
            .captureSnapshot(DeviceIdentity.deviceId(this))
        WireJson.json.encodeToString(ScreenSnapshot.serializer(), snapshot)
    } catch (err: Throwable) {
        errorJson(err)
    }

    private suspend fun actionResultJson(
        block: suspend OperatorAccessibilityService.() -> ActionResult,
    ): String = try {
        val result = withContext(Dispatchers.Default) {
            block(OperatorAccessibilityService.requireService())
        }
        WireJson.json.encodeToString(ActionResult.serializer(), result)
    } catch (err: Throwable) {
        errorJson(err)
    }

    private fun errorJson(err: Throwable): String = WireJson.json.encodeToString(
        ActionResult.serializer(),
        ActionResult(
            status = ActionStatus.FAILED,
            error = err.message ?: err.javaClass.simpleName,
        ),
    )
}

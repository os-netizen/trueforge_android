package dev.trueforge.operator

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.WireJson
import dev.trueforge.operator.ui.OperatorApp
import dev.trueforge.operator.util.DeviceIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private var serviceRunning by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            OperatorApp(
                serviceRunning = serviceRunning,
                onOpenAccessibilitySettings = ::openAccessibilitySettings,
                onCaptureSnapshot = ::captureSnapshot,
                onClickNode = { nodeId ->
                    actionResultJson { clickNode(nodeId) }
                },
                onSetText = { nodeId, text ->
                    actionResultJson { setText(nodeId, text) }
                },
                onGlobalAction = { kind ->
                    actionResultJson { globalAction(kind) }
                },
            )
        }
    }

    override fun onResume() {
        super.onResume()
        serviceRunning = OperatorAccessibilityService.isRunning()
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

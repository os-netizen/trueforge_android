package dev.trueforge.operator.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.WireJson
import dev.trueforge.operator.util.DeviceIdentity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Milestone 2 developer interface: drive snapshot/action commands from adb so
 * verification can happen while another app is in the foreground.
 *
 *   adb shell am broadcast -a dev.trueforge.operator.DEBUG_CAPTURE
 *   adb shell am broadcast -a dev.trueforge.operator.DEBUG_CLICK  --es nodeId n12
 *   adb shell am broadcast -a dev.trueforge.operator.DEBUG_TEXT   --es nodeId n3 --es value hello
 *   adb shell am broadcast -a dev.trueforge.operator.DEBUG_GLOBAL --es kind BACK|HOME
 *
 * Results are logged under tag OperatorDebug.
 */
class DebugCommandReceiver : BroadcastReceiver() {

    companion object {
        const val TAG = "OperatorDebug"
        const val ACTION_CAPTURE = "dev.trueforge.operator.DEBUG_CAPTURE"
        const val ACTION_CLICK = "dev.trueforge.operator.DEBUG_CLICK"
        const val ACTION_TEXT = "dev.trueforge.operator.DEBUG_TEXT"
        const val ACTION_GLOBAL = "dev.trueforge.operator.DEBUG_GLOBAL"

        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    }

    override fun onReceive(context: Context, intent: Intent) {
        val debuggable = (context.applicationInfo.flags and
            android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0
        if (!debuggable) return
        val service = try {
            OperatorAccessibilityService.requireService()
        } catch (err: IllegalStateException) {
            Log.w(TAG, "service unavailable: ${err.message}")
            return
        }
        val pending = goAsync()
        scope.launch {
            try {
                handle(service, context.applicationContext, intent)
            } finally {
                pending.finish()
            }
        }
    }

    private suspend fun handle(
        service: OperatorAccessibilityService,
        appContext: Context,
        intent: Intent,
    ) {
        when (intent.action) {
            ACTION_CAPTURE -> {
                val snapshot = service.captureSnapshot(DeviceIdentity.deviceId(appContext))
                val json = WireJson.json.encodeToString(ScreenSnapshot.serializer(), snapshot)
                // Full JSON to file (logcat truncates long lines); summary to log.
                appContext.openFileOutput("last_snapshot.json", Context.MODE_PRIVATE)
                    .use { it.write(json.toByteArray()) }
                log(
                    """{"snapshotId":"${snapshot.snapshotId}","packageName":"${snapshot.packageName}",""" +
                        """"nodeCount":${snapshot.nodes.size},"file":"last_snapshot.json"}""",
                )
            }
            ACTION_CLICK -> {
                val nodeId = intent.getStringExtra("nodeId") ?: return log(err("missing nodeId"))
                log(WireJson.json.encodeToString(ActionResult.serializer(), service.clickNode(nodeId)))
            }
            ACTION_TEXT -> {
                val nodeId = intent.getStringExtra("nodeId") ?: return log(err("missing nodeId"))
                val value = intent.getStringExtra("value") ?: ""
                log(WireJson.json.encodeToString(ActionResult.serializer(), service.setText(nodeId, value)))
            }
            ACTION_GLOBAL -> {
                val kind = intent.getStringExtra("kind")
                    ?.let { runCatching { OperatorAccessibilityService.GlobalActionKind.valueOf(it) }.getOrNull() }
                    ?: OperatorAccessibilityService.GlobalActionKind.BACK
                log(WireJson.json.encodeToString(ActionResult.serializer(), service.globalAction(kind)))
            }
        }
    }

    private fun err(message: String): String = WireJson.json.encodeToString(
        ActionResult.serializer(),
        ActionResult(status = ActionStatus.FAILED, error = message),
    )

    private fun log(json: String) {
        Log.i(TAG, json.replace("\n", " "))
    }
}

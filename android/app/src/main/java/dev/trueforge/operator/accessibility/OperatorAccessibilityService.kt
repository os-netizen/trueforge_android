package dev.trueforge.operator.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.DeviceState
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.ScreenshotResult as PngShot
import dev.trueforge.operator.snapshots.SnapNode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream

/**
 * Trusted device runtime: reads the accessibility tree, serializes compact
 * snapshots, and executes generic actions. Contains no agent intelligence.
 *
 * Snapshot node ids are deterministic per capture (DFS pre-order) and are
 * only valid for that snapshot (handoff doc section 14).
 */
class OperatorAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "OperatorA11y"
        private const val SCREEN_CHANGE_WAIT_MS = 800L

        @Volatile
        private var running: OperatorAccessibilityService? = null

        fun isRunning(): Boolean = running != null
        fun requireService(): OperatorAccessibilityService =
            running ?: error("Accessibility service is not connected")
    }

    private class Captured(
        val snapshotId: String,
        val foregroundPackage: String?,
        val nodeRefs: Map<String, AccessibilityNodeInfo>,
    )

    @Volatile
    private var lastWindowStatePackage: String? = null

    private var snapshotSeq = 0
    private var captured: Captured? = null

    private val changeWaiters = mutableListOf<CompletableDeferred<Unit>>()

    override fun onServiceConnected() {
        super.onServiceConnected()
        running = this
        Log.i(TAG, "accessibility service connected")
    }

    override fun onDestroy() {
        if (running === this) running = null
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        when (event?.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                lastWindowStatePackage = event.packageName?.toString()
                notifyScreenChanged()
            }
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> notifyScreenChanged()
        }
    }

    private fun notifyScreenChanged() {
        synchronized(changeWaiters) {
            changeWaiters.forEach { it.complete(Unit) }
            changeWaiters.clear()
        }
    }

    private suspend fun awaitScreenChange(timeoutMs: Long): Boolean {
        val waiter = CompletableDeferred<Unit>()
        synchronized(changeWaiters) { changeWaiters.add(waiter) }
        return withTimeoutOrNull(timeoutMs) {
            waiter.await()
            true
        } ?: false
    }

    fun currentForegroundPackage(): String =
        rootInActiveWindow?.packageName?.toString()
            ?: lastWindowStatePackage
            ?: "unknown"

    fun deviceState(deviceId: String): DeviceState = DeviceState(
        deviceId = deviceId,
        online = true,
        foregroundPackage = currentForegroundPackage(),
        orientation = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            "landscape"
        } else {
            "portrait"
        },
        accessibilityServiceEnabled = true,
        lastSnapshotId = captured?.snapshotId,
    )

    fun captureSnapshot(deviceId: String): ScreenSnapshot {
        val root = rootInActiveWindow
            ?: error("No active window; is the service retrieving window content?")
        val nodes = mutableListOf<SnapNode>()
        val refs = mutableMapOf<String, AccessibilityNodeInfo>()

        data class Frame(val node: AccessibilityNodeInfo, val parentId: String?)

        val stack = ArrayDeque<Frame>()
        stack.addFirst(Frame(root, null))
        var index = 0

        while (stack.isNotEmpty()) {
            val frame = stack.removeFirst()
            val id = "n${index++}"
            val rect = Rect().also { frame.node.getBoundsInScreen(it) }
            nodes.add(
                SnapNode(
                    id = id,
                    parentId = frame.parentId,
                    className = frame.node.className?.toString(),
                    text = frame.node.text?.toString(),
                    contentDescription = frame.node.contentDescription?.toString(),
                    viewId = frame.node.viewIdResourceName,
                    bounds = listOf(rect.left, rect.top, rect.right, rect.bottom),
                    clickable = frame.node.isClickable,
                    longClickable = frame.node.isLongClickable,
                    editable = frame.node.isEditable,
                    scrollable = frame.node.isScrollable,
                    focusable = frame.node.isFocusable,
                    enabled = frame.node.isEnabled,
                    selected = frame.node.isSelected,
                    checked = if (frame.node.isCheckable) frame.node.isChecked else null,
                ),
            )
            refs[id] = frame.node
            for (i in frame.node.childCount - 1 downTo 0) {
                frame.node.getChild(i)?.let { child ->
                    stack.addFirst(Frame(child, id))
                }
            }
        }

        val snapshotId = "snap_${++snapshotSeq}"
        captured = Captured(
            snapshotId = snapshotId,
            foregroundPackage = root.packageName?.toString(),
            nodeRefs = refs,
        )
        return ScreenSnapshot(
            deviceId = deviceId,
            snapshotId = snapshotId,
            packageName = root.packageName?.toString() ?: "unknown",
            windowTitle = null,
            timestamp = System.currentTimeMillis(),
            nodes = nodes,
        )
    }

    suspend fun clickNode(nodeId: String): ActionResult =
        clickLike(nodeId, longPress = false)

    suspend fun longClickNode(nodeId: String): ActionResult =
        clickLike(nodeId, longPress = true)

    private suspend fun clickLike(nodeId: String, longPress: Boolean): ActionResult {
        val started = System.currentTimeMillis()
        val ref = captured?.nodeRefs?.get(nodeId)
        if (ref == null) return result(started, ActionStatus.STALE_SNAPSHOT)

        if (!longPress) {
            val semantic = try {
                ref.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            } catch (_: IllegalStateException) {
                false
            }
            // Action hierarchy level 2: gesture tap on known bounds.
            if (semantic) return successWithChange(started)
        }

        val rect = Rect().also { ref.getBoundsInScreen(it) }
        if (rect.isEmpty) return result(started, ActionStatus.FAILED, error = "node has empty bounds")

        val path = Path().apply { moveTo(rect.exactCenterX(), rect.exactCenterY()) }
        val stroke = GestureDescription.StrokeDescription(path, 0, if (longPress) 600L else 60L)
        val ok = dispatchGesture(
            GestureDescription.Builder().addStroke(stroke).build(),
            null,
            null,
        )
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "gesture rejected")
    }

    suspend fun setText(nodeId: String, value: String): ActionResult {
        val started = System.currentTimeMillis()
        val ref = captured?.nodeRefs?.get(nodeId)
            ?: return result(started, ActionStatus.STALE_SNAPSHOT)
        val args = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                value,
            )
        }
        val ok = try {
            ref.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        } catch (_: IllegalStateException) {
            false
        }
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "Node did not accept text")
    }

    suspend fun scroll(direction: String, nodeId: String? = null): ActionResult {
        val started = System.currentTimeMillis()

        var left = 0
        var top = 0
        var right = resources.displayMetrics.widthPixels
        var bottom = resources.displayMetrics.heightPixels

        if (nodeId != null) {
            val ref = captured?.nodeRefs?.get(nodeId) ?: return result(started, ActionStatus.STALE_SNAPSHOT)
            val rect = Rect().also { ref.getBoundsInScreen(it) }
            if (rect.isEmpty) return result(started, ActionStatus.FAILED, error = "scroll target empty")
            left = rect.left; top = rect.top; right = rect.right; bottom = rect.bottom
        }

        val cx = (left + right) / 2
        val cy = (top + bottom) / 2
        val spanX = (right - left) / 3
        val spanY = (bottom - top) / 3

        // Direction denotes where content moves: scrolling "down" reveals
        // content below, so the finger travels upward.
        val (startX, startY, endX, endY) = when (direction) {
            "down" -> listOf(cx, cy + spanY, cx, cy - spanY)
            "up" -> listOf(cx, cy - spanY, cx, cy + spanY)
            "left" -> listOf(cx + spanX, cy, cx - spanX, cy)
            "right" -> listOf(cx - spanX, cy, cx + spanX, cy)
            else -> return result(started, ActionStatus.UNSUPPORTED, error = "unknown direction $direction")
        }

        val ok = dispatchSwipe(startX, startY, endX, endY, durationMs = 300)
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "swipe rejected")
    }

    suspend fun tapCoordinates(x: Int, y: Int): ActionResult {
        val started = System.currentTimeMillis()
        val path = Path().apply {
            moveTo(x.toFloat(), y.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        val ok = dispatchGesture(gesture, null, null)
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "tap rejected")
    }

    suspend fun swipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Int): ActionResult {
        val started = System.currentTimeMillis()
        val ok = dispatchSwipe(startX, startY, endX, endY, durationMs.toLong())
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "swipe rejected")
    }

    suspend fun globalAction(action: GlobalActionKind): ActionResult {
        val started = System.currentTimeMillis()
        val ok = performGlobalAction(action.globalConstant)
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "Global action rejected")
    }

    enum class GlobalActionKind(val globalConstant: Int, val wireName: String) {
        BACK(GLOBAL_ACTION_BACK, "back"),
        HOME(GLOBAL_ACTION_HOME, "home"),
        RECENTS(GLOBAL_ACTION_RECENTS, "recents"),
        NOTIFICATIONS(GLOBAL_ACTION_NOTIFICATIONS, "notifications");

        companion object {
            fun fromWire(name: String): GlobalActionKind? =
                entries.firstOrNull { it.wireName == name }
        }
    }

    fun launchApp(packageName: String): Boolean {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * AccessibilityService.takeScreenshot (API 30+), delivered as base64 PNG.
     * The platform blocks secure windows automatically.
     */
    fun captureScreenshotPng(onDone: (PngShot?) -> Unit) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.R) {
            onDone(null)
            return
        }
        val handler = Handler(Looper.getMainLooper())
        val executor = java.util.concurrent.Executor { command -> handler.post(command) }
        takeScreenshot(
            android.view.Display.DEFAULT_DISPLAY,
            executor,
            object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(
                    result: AccessibilityService.ScreenshotResult,
                ) {
                    try {
                        val wrapped =
                            Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        val bitmap = wrapped?.copy(Bitmap.Config.ARGB_8888, false)
                        result.hardwareBuffer.close()
                        if (bitmap == null) {
                            handler.post { onDone(null) }
                            return
                        }
                        val width = bitmap.width
                        val height = bitmap.height
                        val bytes = ByteArrayOutputStream().use { out ->
                            bitmap.compress(Bitmap.CompressFormat.PNG, 80, out)
                            out.toByteArray()
                        }
                        bitmap.recycle()
                        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
                        handler.post {
                            onDone(PngShot(dataBase64 = encoded, width = width, height = height))
                        }
                    } catch (err: Exception) {
                        Log.w(TAG, "screenshot conversion failed", err)
                        handler.post { onDone(null) }
                    }
                }

                override fun onFailure(errorCode: Int) {
                    Log.w(TAG, "screenshot errorCode=$errorCode")
                    handler.post { onDone(null) }
                }
            },
        )
    }

    private fun dispatchSwipe(startX: Int, startY: Int, endX: Int, endY: Int, durationMs: Long): Boolean {
        val path = Path().apply {
            moveTo(startX.toFloat(), startY.toFloat())
            lineTo(endX.toFloat(), endY.toFloat())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        return dispatchGesture(gesture, null, null)
    }

    private suspend fun successWithChange(started: Long): ActionResult =
        result(started, ActionStatus.SUCCESS, screenChanged = awaitScreenChange(SCREEN_CHANGE_WAIT_MS))

    private fun result(
        started: Long,
        status: ActionStatus,
        error: String? = null,
        screenChanged: Boolean = false,
    ): ActionResult = ActionResult(
        status = status,
        error = error,
        screenChanged = screenChanged,
        foregroundPackage = currentForegroundPackage(),
        latencyMs = System.currentTimeMillis() - started,
    )
}

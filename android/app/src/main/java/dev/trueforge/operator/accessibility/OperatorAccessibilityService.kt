package dev.trueforge.operator.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.SnapNode
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

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

    suspend fun clickNode(nodeId: String): ActionResult {
        val started = System.currentTimeMillis()
        val ref = captured?.nodeRefs?.get(nodeId)
        if (ref == null) return result(started, ActionStatus.STALE_SNAPSHOT)

        val semantic = try {
            ref.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        } catch (_: IllegalStateException) {
            false
        }
        // Action hierarchy level 2: gesture tap on known bounds.
        val viaGesture = !semantic && gestureTap(ref)
        return if (semantic || viaGesture) {
            result(started, ActionStatus.SUCCESS, screenChanged = awaitScreenChange(SCREEN_CHANGE_WAIT_MS))
        } else {
            result(started, ActionStatus.FAILED, error = "Node did not accept click")
        }
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
        return if (ok) {
            result(started, ActionStatus.SUCCESS, screenChanged = awaitScreenChange(SCREEN_CHANGE_WAIT_MS))
        } else {
            result(started, ActionStatus.FAILED, error = "Node did not accept text")
        }
    }

    suspend fun globalAction(action: GlobalActionKind): ActionResult {
        val started = System.currentTimeMillis()
        val ok = performGlobalAction(action.globalConstant)
        return if (ok) {
            result(started, ActionStatus.SUCCESS, screenChanged = awaitScreenChange(SCREEN_CHANGE_WAIT_MS))
        } else {
            result(started, ActionStatus.FAILED, error = "Global action rejected")
        }
    }

    enum class GlobalActionKind(val globalConstant: Int) {
        BACK(GLOBAL_ACTION_BACK),
        HOME(GLOBAL_ACTION_HOME),
        RECENTS(GLOBAL_ACTION_RECENTS),
        NOTIFICATIONS(GLOBAL_ACTION_NOTIFICATIONS),
    }

    /** Level-2 fallback: tap the center of the node's bounds via gesture. */
    private fun gestureTap(node: AccessibilityNodeInfo): Boolean {
        val rect = Rect().also { node.getBoundsInScreen(it) }
        if (rect.isEmpty) return false
        val path = Path().apply {
            moveTo(rect.exactCenterX(), rect.exactCenterY())
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 60))
            .build()
        return dispatchGesture(gesture, null, null)
    }

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

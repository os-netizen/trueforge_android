package dev.trueforge.operator.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.BatteryManager
import android.os.PowerManager
import android.app.KeyguardManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
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
import dev.trueforge.operator.snapshots.NodeRange
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

    fun deviceState(deviceId: String): DeviceState {
        val power = getSystemService(PowerManager::class.java)
        val keyguard = getSystemService(KeyguardManager::class.java)
        val battery = getSystemService(BatteryManager::class.java)
        val connectivity = getSystemService(ConnectivityManager::class.java)
        val network = connectivity.activeNetwork
        val capabilities = network?.let(connectivity::getNetworkCapabilities)
        val audio = getSystemService(AudioManager::class.java)
        return DeviceState(
            deviceId = deviceId,
            online = true,
            foregroundPackage = currentForegroundPackage(),
            orientation = if (resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) "landscape" else "portrait",
            accessibilityServiceEnabled = true,
            lastSnapshotId = captured?.snapshotId,
            screenInteractive = power.isInteractive,
            deviceLocked = keyguard.isDeviceLocked,
            keyguardShowing = keyguard.isKeyguardLocked,
            batteryPercent = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
                .takeIf { it in 0..100 },
            charging = battery.isCharging,
            networkValidated = capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true,
            networkMetered = connectivity.isActiveNetworkMetered,
            mediaVolume = audio.getStreamVolume(AudioManager.STREAM_MUSIC),
            mediaVolumeMax = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC),
        )
    }

    fun captureSnapshot(deviceId: String): ScreenSnapshot {
        val root = rootInActiveWindow
            ?: error("No active window; is the service retrieving window content?")

        // First pass: deterministic DFS pre-order with positional ids.
        val raw = mutableListOf<RawNode>()
        val idStack = ArrayDeque<Pair<AccessibilityNodeInfo, String?>>()
        idStack.addFirst(root to null)
        val refsById = mutableMapOf<String, AccessibilityNodeInfo>()
        var index = 0
        while (idStack.isNotEmpty()) {
            val (node, parentId) = idStack.removeFirst()
            val id = "n${index++}"
            val rect = Rect().also { node.getBoundsInScreen(it) }
            raw.add(
                RawNode(
                    id = id,
                    parentId = parentId,
                    className = node.className?.toString(),
                    text = node.text?.toString(),
                    contentDescription = node.contentDescription?.toString(),
                    viewId = node.viewIdResourceName,
                    bounds = listOf(rect.left, rect.top, rect.right, rect.bottom),
                    clickable = node.isClickable,
                    longClickable = node.isLongClickable,
                    editable = node.isEditable,
                    scrollable = node.isScrollable,
                    focusable = node.isFocusable,
                    selected = node.isSelected,
                    checked = if (node.isCheckable) node.isChecked else null,
                    actions = node.actionList.mapNotNull { actionName(it.id) },
                    range = node.rangeInfo?.let { NodeRange(it.min, it.max, it.current) },
                    enabled = node.isEnabled,
                ),
            )
            refsById[id] = node
            for (i in node.childCount - 1 downTo 0) {
                node.getChild(i)?.let { child ->
                    idStack.addFirst(child to id)
                }
            }
        }

        // Second pass (handoff doc section 42): prune unlabeled, non-interactive
        // containers while keeping ancestors of anything informative. Keeps
        // snapshots inside model-friendly size limits.
        val keep = BooleanArray(raw.size)
        for (i in raw.indices) {
            val n = raw[i]
            keep[i] =
                n.clickable || n.longClickable || n.editable || n.scrollable ||
                    !n.text.isNullOrEmpty() || !n.contentDescription.isNullOrEmpty()
        }
        // Ancestor closure over parentId links.
        val byId = raw.associateBy { it.id }
        for (i in raw.indices) {
            if (!keep[i]) continue
            var p = raw[i].parentId
            while (p != null) {
                val pNode = byId[p] ?: break
                val pIdx = raw.indexOf(pNode)
                if (pIdx >= 0 && !keep[pIdx]) keep[pIdx] = true else break
                p = pNode.parentId
            }
        }

        val nodes = mutableListOf<SnapNode>()
        for (i in raw.indices) {
            if (!keep[i]) continue
            val n = raw[i]
            nodes.add(
                SnapNode(
                    id = n.id,
                    parentId = n.parentId,
                    className = n.className,
                    text = n.text,
                    contentDescription = n.contentDescription,
                    viewId = n.viewId,
                    bounds = n.bounds,
                    clickable = n.clickable,
                    longClickable = n.longClickable,
                    editable = n.editable,
                    scrollable = n.scrollable,
                    focusable = n.focusable,
                    enabled = n.enabled,
                    selected = n.selected,
                    checked = n.checked,
                    actions = n.actions,
                    range = n.range,
                ),
            )
        }

        val snapshotId = "snap_${++snapshotSeq}"
        captured = Captured(
            snapshotId = snapshotId,
            foregroundPackage = root.packageName?.toString(),
            nodeRefs = refsById,
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

    private data class RawNode(
        val id: String,
        val parentId: String?,
        val className: String?,
        val text: String?,
        val contentDescription: String?,
        val viewId: String?,
        val bounds: List<Int>,
        val clickable: Boolean,
        val longClickable: Boolean,
        val editable: Boolean,
        val scrollable: Boolean,
        val focusable: Boolean,
        val selected: Boolean,
        val checked: Boolean?,
        val actions: List<String>,
        val range: NodeRange?,
        val enabled: Boolean,
    )

    suspend fun clickNode(snapshotId: String, nodeId: String): ActionResult =
        clickLike(snapshotId, nodeId, longPress = false)

    suspend fun clickNode(nodeId: String): ActionResult =
        clickNode(captured?.snapshotId.orEmpty(), nodeId)

    suspend fun longClickNode(snapshotId: String, nodeId: String): ActionResult =
        clickLike(snapshotId, nodeId, longPress = true)

    private suspend fun clickLike(snapshotId: String, nodeId: String, longPress: Boolean): ActionResult {
        val started = System.currentTimeMillis()
        if (captured?.snapshotId != snapshotId) return result(started, ActionStatus.STALE_SNAPSHOT)
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

    suspend fun setText(snapshotId: String, nodeId: String, value: String): ActionResult {
        val started = System.currentTimeMillis()
        if (captured?.snapshotId != snapshotId) return result(started, ActionStatus.STALE_SNAPSHOT)
        val ref = captured?.nodeRefs?.get(nodeId)
            ?: return result(started, ActionStatus.STALE_SNAPSHOT)
        // Jetpack Compose apps can expose a labelled semantics wrapper rather
        // than the underlying editor. Focusing the requested target may make a
        // different, otherwise hidden node available through FOCUS_INPUT.
        val ok = setTextWithFocusedFallback(
            target = ref,
            value = value,
            setText = ::performSetText,
            focus = ::focusTextTarget,
            awaitFocused = { awaitInputFocus(ref) },
        )
        return if (ok) successWithChange(started)
        else result(started, ActionStatus.FAILED, error = "Node did not accept text")
    }

    private fun performSetText(node: AccessibilityNodeInfo, value: String): Boolean {
        val args = Bundle().apply {
            putCharSequence(
                AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE,
                value,
            )
        }
        return try {
            node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        } catch (_: IllegalStateException) {
            false
        }
    }

    private suspend fun focusTextTarget(node: AccessibilityNodeInfo) {
        try {
            node.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            if (node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return
        } catch (_: IllegalStateException) {
            // Fall through to the same bounded gesture used by click_node.
        }
        val rect = Rect().also { node.getBoundsInScreen(it) }
        if (rect.isEmpty) return
        val path = Path().apply { moveTo(rect.exactCenterX(), rect.exactCenterY()) }
        val completed = CompletableDeferred<Unit>()
        val dispatched = dispatchGesture(
            GestureDescription.Builder()
                .addStroke(GestureDescription.StrokeDescription(path, 0, 60L))
                .build(),
            object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) {
                    completed.complete(Unit)
                }

                override fun onCancelled(gestureDescription: GestureDescription?) {
                    completed.complete(Unit)
                }
            },
            null,
        )
        if (dispatched) withTimeoutOrNull(800) { completed.await() }
    }

    private suspend fun awaitInputFocus(target: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val targetBounds = Rect().also { target.getBoundsInScreen(it) }
        if (targetBounds.isEmpty) return null
        repeat(5) {
            val focused = try {
                rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
            } catch (_: IllegalStateException) {
                null
            }
            if (focused != null && focusedTextTargetMatches(focused, targetBounds)) return focused
            kotlinx.coroutines.delay(100)
        }
        return null
    }

    private fun focusedTextTargetMatches(node: AccessibilityNodeInfo, targetBounds: Rect): Boolean {
        val acceptsText = node.isEditable || node.actionList.any {
            it.id == AccessibilityNodeInfo.ACTION_SET_TEXT
        }
        if (!acceptsText) return false
        val focusedBounds = Rect().also { node.getBoundsInScreen(it) }
        if (focusedBounds.isEmpty || !Rect.intersects(focusedBounds, targetBounds)) return false
        return targetBounds.contains(focusedBounds.centerX(), focusedBounds.centerY()) ||
            focusedBounds.contains(targetBounds.centerX(), targetBounds.centerY())
    }

    suspend fun setText(nodeId: String, value: String): ActionResult =
        setText(captured?.snapshotId.orEmpty(), nodeId, value)

    suspend fun scroll(snapshotId: String, direction: String, nodeId: String? = null): ActionResult {
        val started = System.currentTimeMillis()
        if (captured?.snapshotId != snapshotId) return result(started, ActionStatus.STALE_SNAPSHOT)

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
        NOTIFICATIONS(GLOBAL_ACTION_NOTIFICATIONS, "notifications"),
        QUICK_SETTINGS(GLOBAL_ACTION_QUICK_SETTINGS, "quick_settings"),
        POWER_DIALOG(GLOBAL_ACTION_POWER_DIALOG, "power_dialog"),
        LOCK_SCREEN(GLOBAL_ACTION_LOCK_SCREEN, "lock_screen"),
        SCREENSHOT(GLOBAL_ACTION_TAKE_SCREENSHOT, "screenshot"),
        DPAD_UP(GLOBAL_ACTION_DPAD_UP, "dpad_up"),
        DPAD_DOWN(GLOBAL_ACTION_DPAD_DOWN, "dpad_down"),
        DPAD_LEFT(GLOBAL_ACTION_DPAD_LEFT, "dpad_left"),
        DPAD_RIGHT(GLOBAL_ACTION_DPAD_RIGHT, "dpad_right"),
        DPAD_CENTER(GLOBAL_ACTION_DPAD_CENTER, "dpad_center");

        companion object {
            fun fromWire(name: String): GlobalActionKind? =
                entries.firstOrNull { it.wireName == name }
        }
    }

    fun launchApp(packageName: String): Boolean {
        val intent = packageManager.getLaunchIntentForPackage(packageName)
            ?: resolveLaunchIntentByLabel(packageName)
            ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            startActivity(intent)
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun resolveLaunchIntentByLabel(name: String): Intent? {
        val query = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val match = packageManager.queryIntentActivities(query, 0).firstOrNull { info ->
            info.loadLabel(packageManager).toString().equals(name, ignoreCase = true)
        } ?: return null
        return Intent(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .setClassName(match.activityInfo.packageName, match.activityInfo.name)
    }

    /**
     * AccessibilityService.takeScreenshot (API 30+), delivered as base64 PNG.
     * The platform blocks secure windows automatically.
     */
    fun captureScreenshot(
        maxDimension: Int? = null,
        format: String = "png",
        quality: Int = 80,
        onDone: (PngShot?) -> Unit,
    ) {
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
                        val sourceWidth = bitmap.width
                        val sourceHeight = bitmap.height
                        // Downsample before encoding: a perception call wants a
                        // legible frame, not a 1200x2000 lossless one, and the
                        // scale factor lets the server map points back to the
                        // native coordinates that tap_coordinates expects.
                        val scaled = scaleToFit(bitmap, maxDimension)
                        val jpeg = format.equals("jpeg", ignoreCase = true)
                        val bytes = ByteArrayOutputStream().use { out ->
                            scaled.compress(
                                if (jpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG,
                                quality.coerceIn(1, 100),
                                out,
                            )
                            out.toByteArray()
                        }
                        val width = scaled.width
                        val height = scaled.height
                        if (scaled !== bitmap) scaled.recycle()
                        bitmap.recycle()
                        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
                        handler.post {
                            onDone(
                                PngShot(
                                    format = if (jpeg) "jpeg" else "png",
                                    dataBase64 = encoded,
                                    width = width,
                                    height = height,
                                    sourceWidth = sourceWidth,
                                    sourceHeight = sourceHeight,
                                ),
                            )
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

    /** Fits the longest edge to [maxDimension], preserving aspect ratio. Returns the input when no cap applies. */
    private fun scaleToFit(bitmap: Bitmap, maxDimension: Int?): Bitmap {
        val cap = maxDimension ?: return bitmap
        val longest = maxOf(bitmap.width, bitmap.height)
        if (cap <= 0 || longest <= cap) return bitmap
        val ratio = cap.toDouble() / longest.toDouble()
        val width = (bitmap.width * ratio).toInt().coerceAtLeast(1)
        val height = (bitmap.height * ratio).toInt().coerceAtLeast(1)
        return Bitmap.createScaledBitmap(bitmap, width, height, true)
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

    private fun actionName(id: Int): String? = when (id) {
        AccessibilityNodeInfo.ACTION_CLICK -> "click"
        AccessibilityNodeInfo.ACTION_LONG_CLICK -> "long_click"
        AccessibilityNodeInfo.ACTION_SET_TEXT -> "set_text"
        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD -> "scroll_forward"
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD -> "scroll_backward"
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id -> "scroll_up"
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id -> "scroll_down"
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id -> "scroll_left"
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id -> "scroll_right"
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_PROGRESS.id -> "set_progress"
        AccessibilityNodeInfo.ACTION_SELECT -> "select"
        AccessibilityNodeInfo.ACTION_CLEAR_SELECTION -> "clear_selection"
        AccessibilityNodeInfo.ACTION_EXPAND -> "expand"
        AccessibilityNodeInfo.ACTION_COLLAPSE -> "collapse"
        AccessibilityNodeInfo.ACTION_DISMISS -> "dismiss"
        AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id -> "show_on_screen"
        else -> null
    }

    private suspend fun successWithChange(started: Long): ActionResult {
        val changed = awaitScreenChange(SCREEN_CHANGE_WAIT_MS)
        if (changed) {
            // Let window transitions settle so the reported package is fresh.
            kotlinx.coroutines.delay(150)
        }
        return result(started, ActionStatus.SUCCESS, screenChanged = changed)
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

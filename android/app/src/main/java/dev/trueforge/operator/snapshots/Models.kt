package dev.trueforge.operator.snapshots

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * Kotlin mirror of the TypeScript wire contract in
 * packages/protocol/src/snapshots.ts. Field names must stay in sync.
 */

@Serializable
data class SnapNode(
    val id: String,
    val parentId: String?,
    val className: String?,
    val text: String?,
    val contentDescription: String?,
    val viewId: String?,
    /** [left, top, right, bottom] in screen pixels. */
    val bounds: List<Int>,
    val clickable: Boolean,
    val longClickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val focusable: Boolean,
    val enabled: Boolean,
    val selected: Boolean,
    val checked: Boolean?,
    val actions: List<String> = emptyList(),
    val range: NodeRange? = null,
)

@Serializable
data class NodeRange(val min: Float, val max: Float, val current: Float)

@Serializable
data class ScreenSnapshot(
    val deviceId: String,
    val snapshotId: String,
    val packageName: String,
    val windowTitle: String?,
    val timestamp: Long,
    val nodes: List<SnapNode>,
)

@Serializable
enum class ActionStatus {
    @SerialName("success") SUCCESS,
    @SerialName("failed") FAILED,
    @SerialName("stale_snapshot") STALE_SNAPSHOT,
    @SerialName("unsupported") UNSUPPORTED,
}

@Serializable
data class ActionResult(
    val status: ActionStatus,
    val error: String? = null,
    val screenChanged: Boolean = false,
    val foregroundPackage: String? = null,
    val latencyMs: Long = 0,
)

@Serializable
data class DeviceState(
    val deviceId: String,
    val online: Boolean,
    val foregroundPackage: String?,
    val orientation: String,
    val accessibilityServiceEnabled: Boolean,
    val lastSnapshotId: String?,
    val activeTaskId: String? = null,
    val screenInteractive: Boolean,
    val deviceLocked: Boolean,
    val keyguardShowing: Boolean,
    val batteryPercent: Int? = null,
    val charging: Boolean,
    val networkValidated: Boolean,
    val networkMetered: Boolean,
    val mediaVolume: Int,
    val mediaVolumeMax: Int,
)

@Serializable
data class MediaSessionState(
    val packageName: String,
    val title: String? = null,
    val artist: String? = null,
    val album: String? = null,
    val playbackState: String,
    val positionMs: Long? = null,
    val durationMs: Long? = null,
    val supportedActions: List<String> = emptyList(),
)

@Serializable
data class MediaState(
    val available: Boolean,
    val permissionRequired: Boolean,
    val sessions: List<MediaSessionState> = emptyList(),
)

@Serializable
data class NotificationState(
    val key: String,
    val packageName: String,
    val title: String? = null,
    val text: String? = null,
    val postedAt: Long,
    val ongoing: Boolean,
    val actions: List<String> = emptyList(),
)

@Serializable
data class ScreenshotResult(
    @SerialName("format") val format: String = "png",
    /** Base64 encoded image bytes. Ephemeral by policy (doc section 34). */
    @SerialName("dataBase64") val dataBase64: String,
    /** Encoded size, after any downsampling. */
    @SerialName("width") val width: Int,
    @SerialName("height") val height: Int,
    /** Native capture size, so the server can map image points back to screen coordinates. */
    @SerialName("sourceWidth") val sourceWidth: Int,
    @SerialName("sourceHeight") val sourceHeight: Int,
)

object WireJson {
    val json: Json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
        explicitNulls = true
    }
}

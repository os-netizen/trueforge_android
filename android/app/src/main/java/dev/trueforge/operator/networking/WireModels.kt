package dev.trueforge.operator.networking

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import dev.trueforge.operator.snapshots.ScreenshotResult

/**
 * Kotlin mirror of the wire contract in packages/protocol/src/device.ts and
 * actions.ts. Field names, discriminators, and shapes must stay in sync.
 */

const val PROTOCOL_VERSION = 1

@Serializable
data class DeviceHello(
    @SerialName("protocolVersion") val protocolVersion: Int = PROTOCOL_VERSION,
    @SerialName("deviceId") val deviceId: String,
    @SerialName("model") val model: String?,
    @SerialName("androidVersion") val androidVersion: String?,
    @SerialName("accessibilityServiceEnabled") val accessibilityServiceEnabled: Boolean,
)

@Serializable
sealed interface DeviceRequest {
    val requestId: String

    @Serializable
    @SerialName("get_screen")
    data class GetScreen(override val requestId: String) : DeviceRequest

    @Serializable
    @SerialName("execute_action")
    data class ExecuteAction(
        override val requestId: String,
        @SerialName("snapshotId") val snapshotId: String? = null,
        @SerialName("action") val action: DeviceAction,
    ) : DeviceRequest

    @Serializable
    @SerialName("capture_screenshot")
    data class CaptureScreenshot(override val requestId: String) : DeviceRequest

    @Serializable
    @SerialName("get_device_state")
    data class GetDeviceState(override val requestId: String) : DeviceRequest

    @Serializable
    @SerialName("cancel_task")
    data class CancelTask(
        override val requestId: String,
        @SerialName("taskId") val taskId: String,
    ) : DeviceRequest
}

@Serializable
sealed interface DeviceAction {

    @Serializable
    @SerialName("click_node")
    data class ClickNode(@SerialName("nodeId") val nodeId: String) : DeviceAction

    @Serializable
    @SerialName("long_click_node")
    data class LongClickNode(@SerialName("nodeId") val nodeId: String) : DeviceAction

    @Serializable
    @SerialName("set_text")
    data class SetText(
        @SerialName("nodeId") val nodeId: String,
        @SerialName("text") val text: String,
    ) : DeviceAction

    @Serializable
    @SerialName("scroll")
    data class Scroll(
        @SerialName("direction") val direction: String,
        @SerialName("nodeId") val nodeId: String? = null,
    ) : DeviceAction

    @Serializable
    @SerialName("tap_coordinates")
    data class TapCoordinates(
        @SerialName("x") val x: Int,
        @SerialName("y") val y: Int,
    ) : DeviceAction

    @Serializable
    @SerialName("swipe")
    data class Swipe(
        @SerialName("startX") val startX: Int,
        @SerialName("startY") val startY: Int,
        @SerialName("endX") val endX: Int,
        @SerialName("endY") val endY: Int,
        @SerialName("durationMs") val durationMs: Int = 300,
    ) : DeviceAction

    @Serializable
    @SerialName("global_action")
    data class GlobalAction(@SerialName("action") val action: String) : DeviceAction

    @Serializable
    @SerialName("launch_app")
    data class LaunchApp(@SerialName("packageName") val packageName: String) : DeviceAction
}

@Serializable
sealed interface DeviceResponse {
    val requestId: String
    val ok: Boolean
    val error: String?

    @Serializable
    @SerialName("get_screen")
    data class GetScreen(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: dev.trueforge.operator.snapshots.ScreenSnapshot? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("execute_action")
    data class ExecuteAction(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: dev.trueforge.operator.snapshots.ActionResult? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("capture_screenshot")
    data class CaptureScreenshot(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: ScreenshotResult? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("get_device_state")
    data class GetDeviceState(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: dev.trueforge.operator.snapshots.DeviceState? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("cancel_task")
    data class CancelTask(
        override val requestId: String,
        override val ok: Boolean,
        override val error: String? = null,
    ) : DeviceResponse
}

object WireJsonClient {
    val json: Json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
        classDiscriminator = "type"
    }
}

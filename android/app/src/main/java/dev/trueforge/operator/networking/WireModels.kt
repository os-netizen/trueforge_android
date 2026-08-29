package dev.trueforge.operator.networking

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import dev.trueforge.operator.snapshots.ScreenshotResult

/**
 * Kotlin mirror of the wire contract in packages/protocol/src/device.ts and
 * actions.ts. Field names, discriminators, and shapes must stay in sync.
 */

const val PROTOCOL_VERSION = 5

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
    data class CaptureScreenshot(
        override val requestId: String,
        /** Longest-edge cap; the frame is downsampled here so the socket never carries a full tablet bitmap. */
        @SerialName("maxDimension") val maxDimension: Int? = null,
        @SerialName("format") val format: String = "png",
        @SerialName("quality") val quality: Int = 80,
    ) : DeviceRequest

    @Serializable
    @SerialName("get_device_state")
    data class GetDeviceState(override val requestId: String) : DeviceRequest

    @Serializable
    @SerialName("get_media_state")
    data class GetMediaState(override val requestId: String) : DeviceRequest

    @Serializable
    @SerialName("get_notifications")
    data class GetNotifications(override val requestId: String) : DeviceRequest

    @Serializable
    @SerialName("cancel_task")
    data class CancelTask(
        override val requestId: String,
        @SerialName("taskId") val taskId: String,
    ) : DeviceRequest

    @Serializable
    @SerialName("request_approval")
    data class RequestApproval(
        override val requestId: String,
        @SerialName("toolCallId") val toolCallId: String,
        @SerialName("intent") val intent: String,
        @SerialName("actionJson") val actionJson: String,
        @SerialName("timeoutMs") val timeoutMs: Long,
    ) : DeviceRequest

    @Serializable
    @SerialName("request_user_question")
    data class RequestUserQuestion(
        override val requestId: String,
        @SerialName("toolCallId") val toolCallId: String,
        @SerialName("question") val question: String,
        @SerialName("options") val options: List<String>,
        @SerialName("timeoutMs") val timeoutMs: Long,
    ) : DeviceRequest
}

@Serializable
sealed interface DeviceAction {

    @Serializable
    @SerialName("click_node")
    data class ClickNode(
        @SerialName("snapshotId") val snapshotId: String,
        @SerialName("nodeId") val nodeId: String,
    ) : DeviceAction

    @Serializable
    @SerialName("long_click_node")
    data class LongClickNode(
        @SerialName("snapshotId") val snapshotId: String,
        @SerialName("nodeId") val nodeId: String,
    ) : DeviceAction

    @Serializable
    @SerialName("set_text")
    data class SetText(
        @SerialName("snapshotId") val snapshotId: String,
        @SerialName("nodeId") val nodeId: String,
        @SerialName("text") val text: String,
    ) : DeviceAction

    @Serializable
    @SerialName("scroll")
    data class Scroll(
        @SerialName("snapshotId") val snapshotId: String,
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

    @Serializable
    @SerialName("media_control")
    data class MediaControl(
        @SerialName("action") val action: String,
        @SerialName("packageName") val packageName: String? = null,
    ) : DeviceAction

    @Serializable
    @SerialName("notification_action")
    data class NotificationAction(
        @SerialName("key") val key: String,
        @SerialName("action") val action: String,
        @SerialName("actionIndex") val actionIndex: Int? = null,
    ) : DeviceAction
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
    @SerialName("get_media_state")
    data class GetMediaState(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: dev.trueforge.operator.snapshots.MediaState? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("get_notifications")
    data class GetNotifications(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: List<dev.trueforge.operator.snapshots.NotificationState>? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("cancel_task")
    data class CancelTask(
        override val requestId: String,
        override val ok: Boolean,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("request_approval")
    data class RequestApproval(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: ApprovalDecision? = null,
        override val error: String? = null,
    ) : DeviceResponse

    @Serializable
    @SerialName("request_user_question")
    data class RequestUserQuestion(
        override val requestId: String,
        override val ok: Boolean,
        @SerialName("result") val result: UserQuestionResult? = null,
        override val error: String? = null,
    ) : DeviceResponse
}

@Serializable
data class ApprovalDecision(
    /** "allow" or "deny". */
    @SerialName("decision") val decision: String,
    @SerialName("reason") val reason: String? = null,
) {
    companion object {
        fun allow(reason: String? = null): ApprovalDecision = ApprovalDecision("allow", reason)
        fun deny(reason: String?): ApprovalDecision = ApprovalDecision("deny", reason)
    }
}

@Serializable
data class UserQuestionResult(
    @SerialName("content") val content: String,
)

object WireJsonClient {
    val json: Json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
        classDiscriminator = "type"
    }
}

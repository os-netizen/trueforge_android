package dev.trueforge.operator.networking

import android.content.Context
import android.util.Log
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.approvals.ApprovalCoordinator
import dev.trueforge.operator.questions.QuestionCoordinator
import dev.trueforge.operator.media.MediaSessionController
import dev.trueforge.operator.media.OperatorNotificationListenerService
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.WireJson
import dev.trueforge.operator.util.DeviceIdentity
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Maps wire requests onto the accessibility runtime. Transport-agnostic so it
 * can be reused by any connection surface.
 */
class RequestDispatcher(
    private val appContext: Context,
    private val service: () -> OperatorAccessibilityService,
) {
    companion object {
        private const val TAG = "OperatorDispatch"
    }

    suspend fun dispatch(requestJson: String): String? = try {
        val request = WireJsonClient.json.decodeFromString(
            DeviceRequest.serializer(),
            requestJson,
        )
        val response = route(request)
        WireJsonClient.json.encodeToString(DeviceResponse.serializer(), response)
    } catch (err: Exception) {
        Log.w(TAG, "dispatch failed for $requestJson", err)
        null
    }

    private suspend fun route(request: DeviceRequest): DeviceResponse =
        when (request) {
            is DeviceRequest.GetScreen -> {
                val snapshot = runCatching { service().captureSnapshot(deviceId()) }
                DeviceResponse.GetScreen(
                    requestId = request.requestId,
                    ok = snapshot.isSuccess,
                    result = snapshot.getOrNull(),
                    error = snapshot.exceptionOrNull()?.message,
                )
            }

            is DeviceRequest.ExecuteAction -> DeviceResponse.ExecuteAction(
                requestId = request.requestId,
                ok = true,
                result = executeAction(request.action),
            )

            is DeviceRequest.CaptureScreenshot -> {
                val shot = suspendCancellableCoroutine { cont ->
                    service().captureScreenshot(
                        maxDimension = request.maxDimension,
                        format = request.format,
                        quality = request.quality,
                    ) { result -> cont.resumeWith(Result.success(result)) }
                }
                DeviceResponse.CaptureScreenshot(
                    requestId = request.requestId,
                    ok = shot != null,
                    result = shot,
                    error = if (shot == null) "screenshot unavailable" else null,
                )
            }

            is DeviceRequest.GetDeviceState -> DeviceResponse.GetDeviceState(
                requestId = request.requestId,
                ok = true,
                result = service().deviceState(deviceId()),
            )

            is DeviceRequest.GetMediaState -> {
                val state = MediaSessionController(appContext).state()
                DeviceResponse.GetMediaState(
                    requestId = request.requestId,
                    ok = state.available,
                    result = state,
                    error = if (state.available) null else "notification listener access required",
                )
            }

            is DeviceRequest.GetNotifications -> {
                val notifications = OperatorNotificationListenerService.notifications()
                DeviceResponse.GetNotifications(
                    requestId = request.requestId,
                    ok = notifications != null,
                    result = notifications,
                    error = if (notifications == null) "notification listener access required" else null,
                )
            }

            is DeviceRequest.CancelTask -> DeviceResponse.CancelTask(
                requestId = request.requestId,
                ok = true,
            )

            // Suspends for as long as the human takes. Each inbound message is
            // dispatched in its own coroutine (see DeviceConnection.onMessage),
            // so a pending approval never blocks other requests.
            is DeviceRequest.RequestApproval -> DeviceResponse.RequestApproval(
                requestId = request.requestId,
                ok = true,
                result = ApprovalCoordinator.request(appContext, request),
            )

            is DeviceRequest.RequestUserQuestion -> {
                val answer = QuestionCoordinator.request(appContext, request)
                DeviceResponse.RequestUserQuestion(
                    requestId = request.requestId,
                    ok = answer != null,
                    result = answer,
                    error = if (answer == null) "Question was cancelled or timed out" else null,
                )
            }
        }

    private suspend fun executeAction(action: DeviceAction): ActionResult {
        val svc = service()
        return when (action) {
            is DeviceAction.ClickNode -> svc.clickNode(action.snapshotId, action.nodeId)
            is DeviceAction.LongClickNode -> svc.longClickNode(action.snapshotId, action.nodeId)
            is DeviceAction.SetText -> svc.setText(action.snapshotId, action.nodeId, action.text)
            is DeviceAction.Scroll -> svc.scroll(action.snapshotId, action.direction, action.nodeId)
            is DeviceAction.TapCoordinates -> svc.tapCoordinates(action.x, action.y)
            is DeviceAction.Swipe ->
                svc.swipe(action.startX, action.startY, action.endX, action.endY, action.durationMs)

            is DeviceAction.GlobalAction -> {
                val kind = OperatorAccessibilityService.GlobalActionKind.fromWire(action.action)
                if (kind == null) {
                    ActionResult(
                        status = ActionStatus.UNSUPPORTED,
                        error = "unknown global action ${action.action}",
                    )
                } else {
                    svc.globalAction(kind)
                }
            }

            is DeviceAction.LaunchApp -> ActionResult(
                status = if (svc.launchApp(action.packageName)) ActionStatus.SUCCESS else ActionStatus.FAILED,
                error = null,
                screenChanged = false,
                foregroundPackage = svc.currentForegroundPackage(),
            )

            is DeviceAction.MediaControl ->
                MediaSessionController(appContext).control(action.action, action.packageName)

            is DeviceAction.NotificationAction ->
                OperatorNotificationListenerService.control(
                    action.key,
                    action.action,
                    action.actionIndex,
                )
        }
    }

    private fun deviceId(): String = DeviceIdentity.deviceId(appContext)
}

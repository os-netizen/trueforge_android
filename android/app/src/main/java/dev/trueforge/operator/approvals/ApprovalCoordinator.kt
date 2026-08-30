package dev.trueforge.operator.approvals

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.net.toUri
import dev.trueforge.operator.interactions.AgentInteractionNotifications
import dev.trueforge.operator.networking.ApprovalDecision
import dev.trueforge.operator.networking.DeviceRequest
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap

/**
 * The phone is the approval surface (Milestone 6).
 *
 * The server pauses a TrueForge turn on `commit_action` and asks this device to
 * decide. Two surfaces resolve the same request — a heads-up notification with
 * Allow/Deny actions (which fires over whatever app the agent is driving) and
 * an in-app dialog when the operator app is foreground. First decision wins;
 * silence past the deadline denies.
 */
object ApprovalCoordinator {

    private const val TAG = "OperatorApproval"
    data class PendingApproval(
        val requestId: String,
        val toolCallId: String,
        val intent: String,
        val actionJson: String,
        val deadlineUptimeMs: Long,
    )

    private val _pending = MutableStateFlow<PendingApproval?>(null)

    /** Currently outstanding approval, or null. Collected by the UI. */
    val pending: StateFlow<PendingApproval?> = _pending

    private val waiters = ConcurrentHashMap<String, CompletableDeferred<ApprovalDecision>>()
    private val notificationIds = ConcurrentHashMap<String, Int>()

    /**
     * Publishes the request to both surfaces and suspends until a decision or
     * the deadline. Never throws: an unanswered prompt denies.
     */
    suspend fun request(
        context: Context,
        request: DeviceRequest.RequestApproval,
    ): ApprovalDecision {
        val appContext = context.applicationContext
        val deferred = synchronized(this) {
            if (waiters.isNotEmpty()) {
                return ApprovalDecision.deny("another approval is already pending on the device")
            }
            CompletableDeferred<ApprovalDecision>().also {
                waiters[request.requestId] = it
                _pending.value = PendingApproval(
                    requestId = request.requestId,
                    toolCallId = request.toolCallId,
                    intent = request.intent,
                    actionJson = request.actionJson,
                    deadlineUptimeMs = android.os.SystemClock.uptimeMillis() + request.timeoutMs,
                )
            }
        }
        postNotification(appContext, request)

        return try {
            withTimeoutOrNull(request.timeoutMs) { deferred.await() }
                ?: ApprovalDecision.deny("timed out waiting for a decision on the device")
        } finally {
            clear(appContext, request.requestId)
        }
    }

    /** Resolves an outstanding request from any surface. Later calls are no-ops. */
    fun resolve(context: Context, requestId: String, decision: String, reason: String? = null) {
        val waiter = waiters[requestId]
        if (waiter == null) {
            Log.w(TAG, "no pending approval for $requestId")
            return
        }
        val normalized = if (decision == "allow") {
            ApprovalDecision.allow(reason)
        } else {
            ApprovalDecision.deny(reason ?: "denied on device")
        }
        waiter.complete(normalized)
        clear(context.applicationContext, requestId)
    }

    private fun clear(appContext: Context, requestId: String) {
        waiters.remove(requestId)
        notificationIds.remove(requestId)?.let { id ->
            appContext.getSystemService(NotificationManager::class.java).cancel(id)
        }
        if (_pending.value?.requestId == requestId) _pending.value = null
    }

    private fun postNotification(
        appContext: Context,
        request: DeviceRequest.RequestApproval,
    ) {
        val manager = appContext.getSystemService(NotificationManager::class.java)
        val notificationId = AgentInteractionNotifications.nextId()
        notificationIds[request.requestId] = notificationId

        val notification = AgentInteractionNotifications.builder(
            context = appContext,
            notificationId = notificationId,
            title = "Approve this action?",
            body = request.intent,
            category = android.app.Notification.CATEGORY_CALL,
            smallIcon = android.R.drawable.ic_dialog_alert,
        )
            // CATEGORY_CALL keeps the heads-up above the app the agent is driving.
            .addAction(
                android.R.drawable.ic_menu_send,
                "Allow",
                decisionIntent(appContext, request.requestId, "allow", notificationId),
            )
            .addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Deny",
                decisionIntent(appContext, request.requestId, "deny", notificationId),
            )
            .build()

        manager.notify(notificationId, notification)
    }

    private fun decisionIntent(
        appContext: Context,
        requestId: String,
        decision: String,
        notificationId: Int,
    ): PendingIntent = PendingIntent.getBroadcast(
        appContext,
        // Distinct request codes so Allow and Deny do not share one PendingIntent.
        notificationId * 2 + if (decision == "allow") 1 else 0,
        Intent(appContext, ApprovalDecisionReceiver::class.java).apply {
            action = ApprovalDecisionReceiver.ACTION_DECIDE
            data = "trueforge://approval/${Uri.encode(requestId)}/$decision".toUri()
            setPackage(appContext.packageName)
            putExtra(ApprovalDecisionReceiver.EXTRA_REQUEST_ID, requestId)
            putExtra(ApprovalDecisionReceiver.EXTRA_DECISION, decision)
        },
        PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

package dev.trueforge.operator.approvals

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import dev.trueforge.operator.MainActivity
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
    const val CHANNEL_ID = "operator_approvals"
    private const val NOTIFICATION_ID_BASE = 4200

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
        val deferred = CompletableDeferred<ApprovalDecision>()
        waiters[request.requestId] = deferred
        _pending.value = PendingApproval(
            requestId = request.requestId,
            toolCallId = request.toolCallId,
            intent = request.intent,
            actionJson = request.actionJson,
            deadlineUptimeMs = android.os.SystemClock.uptimeMillis() + request.timeoutMs,
        )
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
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Action approvals",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Approve or deny consequential actions the agent wants to take"
                setShowBadge(true)
            },
        )

        val notificationId = NOTIFICATION_ID_BASE + (request.requestId.hashCode() and 0xFF)
        notificationIds[request.requestId] = notificationId

        val open = PendingIntent.getActivity(
            appContext,
            notificationId,
            Intent(appContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("Approve this action?")
            .setContentText(request.intent)
            .setStyle(NotificationCompat.BigTextStyle().bigText(request.intent))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            // CATEGORY_CALL keeps the heads-up above the app the agent is driving.
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(false)
            .setOngoing(true)
            .setContentIntent(open)
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
            setPackage(appContext.packageName)
            putExtra(ApprovalDecisionReceiver.EXTRA_REQUEST_ID, requestId)
            putExtra(ApprovalDecisionReceiver.EXTRA_DECISION, decision)
        },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

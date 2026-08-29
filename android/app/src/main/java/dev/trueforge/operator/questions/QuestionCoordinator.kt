package dev.trueforge.operator.questions

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import dev.trueforge.operator.MainActivity
import dev.trueforge.operator.networking.DeviceRequest
import dev.trueforge.operator.networking.UserQuestionResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Coordinates non-safety user questions separately from binary action approvals. */
object QuestionCoordinator {
    const val CHANNEL_ID = "operator_questions"
    private const val NOTIFICATION_ID_BASE = 4600
    private val nextNotificationId = AtomicInteger(NOTIFICATION_ID_BASE)

    data class PendingQuestion(
        val requestId: String,
        val toolCallId: String,
        val question: String,
        val options: List<String>,
        val deadlineUptimeMs: Long,
    )

    private val _pending = MutableStateFlow<PendingQuestion?>(null)
    val pending: StateFlow<PendingQuestion?> = _pending
    private val waiters = ConcurrentHashMap<String, CompletableDeferred<UserQuestionResult?>>()
    private val notificationIds = ConcurrentHashMap<String, Int>()

    suspend fun request(
        context: Context,
        request: DeviceRequest.RequestUserQuestion,
    ): UserQuestionResult? {
        val appContext = context.applicationContext
        val deferred = synchronized(this) {
            if (waiters.isNotEmpty()) return null
            CompletableDeferred<UserQuestionResult?>().also {
                waiters[request.requestId] = it
                _pending.value = PendingQuestion(
                    request.requestId,
                    request.toolCallId,
                    request.question,
                    request.options.take(5),
                    android.os.SystemClock.uptimeMillis() + request.timeoutMs,
                )
            }
        }
        postNotification(appContext, request)
        return try {
            withTimeoutOrNull(request.timeoutMs) { deferred.await() }
        } finally {
            clear(appContext, request.requestId)
        }
    }

    fun resolve(context: Context, requestId: String, content: String?) {
        val waiter = waiters[requestId] ?: return
        waiter.complete(content?.trim()?.takeIf { it.isNotEmpty() }?.let(::UserQuestionResult))
        clear(context.applicationContext, requestId)
    }

    private fun clear(appContext: Context, requestId: String) {
        waiters.remove(requestId)
        notificationIds.remove(requestId)?.let {
            appContext.getSystemService(NotificationManager::class.java).cancel(it)
        }
        if (_pending.value?.requestId == requestId) _pending.value = null
    }

    private fun postNotification(context: Context, request: DeviceRequest.RequestUserQuestion) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Agent questions",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = "Questions the agent needs you to answer before continuing" },
        )
        val notificationId = nextNotificationId.incrementAndGet()
        notificationIds[request.requestId] = notificationId
        val open = PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        manager.notify(
            notificationId,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Agent needs your input")
                .setContentText(request.question)
                .setStyle(NotificationCompat.BigTextStyle().bigText(request.question))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(open)
                .addAction(android.R.drawable.ic_menu_edit, "Answer", open)
                .build(),
        )
    }
}

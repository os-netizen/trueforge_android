package dev.trueforge.operator.questions

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.core.net.toUri
import dev.trueforge.operator.interactions.AgentInteractionNotifications
import dev.trueforge.operator.networking.DeviceRequest
import dev.trueforge.operator.networking.UserQuestionResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.ConcurrentHashMap

/** Coordinates non-safety user questions separately from binary action approvals. */
object QuestionCoordinator {
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
                    QuestionAnswers.options(request.options),
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
        waiter.complete(QuestionAnswers.normalize(content)?.let(::UserQuestionResult))
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
        val notificationId = AgentInteractionNotifications.nextId()
        notificationIds[request.requestId] = notificationId
        val answerIntent = PendingIntent.getBroadcast(
            context,
            notificationId,
            android.content.Intent(context, QuestionAnswerReceiver::class.java).apply {
                action = QuestionAnswerReceiver.ACTION_ANSWER
                data = "trueforge://question/${Uri.encode(request.requestId)}".toUri()
                setPackage(context.packageName)
                putExtra(QuestionAnswerReceiver.EXTRA_REQUEST_ID, request.requestId)
            },
            // RemoteInput must be able to attach the reply bundle to this intent.
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val options = QuestionAnswers.options(request.options)
        val remoteInput = RemoteInput.Builder(QuestionAnswerReceiver.REMOTE_INPUT_KEY)
            .setLabel("Type your answer")
            .setChoices(options.map { it as CharSequence }.toTypedArray())
            .setAllowFreeFormInput(true)
            .setEditChoicesBeforeSending(RemoteInput.EDIT_CHOICES_BEFORE_SENDING_DISABLED)
            .build()
        val answerAction = NotificationCompat.Action.Builder(
            android.R.drawable.ic_menu_edit,
            "Answer",
            answerIntent,
        )
            .addRemoteInput(remoteInput)
            .setAllowGeneratedReplies(false)
            .build()
        manager.notify(
            notificationId,
            AgentInteractionNotifications.builder(
                context = context,
                notificationId = notificationId,
                title = "Agent needs your input",
                body = request.question,
                category = android.app.Notification.CATEGORY_MESSAGE,
                smallIcon = android.R.drawable.ic_dialog_info,
            )
                .addAction(answerAction)
                .build(),
        )
    }
}

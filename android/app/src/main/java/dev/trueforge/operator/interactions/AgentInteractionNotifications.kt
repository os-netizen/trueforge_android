package dev.trueforge.operator.interactions

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import dev.trueforge.operator.MainActivity
import java.util.concurrent.atomic.AtomicInteger

/** Shared notification surface for every interaction that pauses an agent turn. */
object AgentInteractionNotifications {
    const val CHANNEL_ID = "agent_interactions"
    private const val NOTIFICATION_ID_BASE = 4200
    private val nextNotificationId = AtomicInteger(NOTIFICATION_ID_BASE)

    fun nextId(): Int = nextNotificationId.incrementAndGet()

    fun builder(
        context: Context,
        notificationId: Int,
        title: String,
        body: String,
        category: String,
        smallIcon: Int,
    ): NotificationCompat.Builder {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Agent interactions",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "Questions and action confirmations from the agent"
                setShowBadge(true)
            },
        )

        val openOperator = PendingIntent.getActivity(
            context,
            notificationId,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(smallIcon)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(category)
            .setAutoCancel(false)
            .setOngoing(true)
            .setContentIntent(openOperator)
    }

    /** Replaces an orphaned direct-reply prompt with an honest delivery failure. */
    fun showReplyDeliveryFailure(context: Context, notificationId: Int) {
        val notification = builder(
            context = context,
            notificationId = notificationId,
            title = "Answer not delivered",
            body = "The agent connection restarted. Open Operator and retry the run.",
            category = android.app.Notification.CATEGORY_ERROR,
            smallIcon = android.R.drawable.ic_dialog_alert,
        )
            .setOngoing(false)
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java)
            .notify(notificationId, notification)
    }
}

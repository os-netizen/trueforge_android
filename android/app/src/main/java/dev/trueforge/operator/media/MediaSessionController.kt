package dev.trueforge.operator.media

import android.content.ComponentName
import android.content.Context
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.provider.Settings
import android.service.notification.NotificationListenerService
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.MediaSessionState
import dev.trueforge.operator.snapshots.MediaState
import dev.trueforge.operator.snapshots.NotificationState
import android.app.Notification

/**
 * Exposes Android's media-session control plane to the agent. Accessibility
 * describes rendered UI, but it cannot reliably answer whether media is
 * playing or invoke transport controls without app-specific coordinates.
 */
class OperatorNotificationListenerService : NotificationListenerService() {
    companion object {
        @Volatile private var running: OperatorNotificationListenerService? = null

        fun notifications(): List<NotificationState>? = running?.let { service ->
          service.activeNotifications.filter { it.packageName != service.packageName }.map { item ->
            val extras = item.notification.extras
            NotificationState(
                key = item.key,
                packageName = item.packageName,
                title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(),
                text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString(),
                postedAt = item.postTime,
                ongoing = item.isOngoing,
                actions = item.notification.actions?.map { it.title?.toString().orEmpty() } ?: emptyList(),
            )
          }
        }

        fun control(key: String, action: String, actionIndex: Int?): ActionResult {
            val started = System.currentTimeMillis()
            val service = running ?: return ActionResult(
                status = ActionStatus.UNSUPPORTED,
                error = "notification listener access required",
            )
            val item = service.activeNotifications.firstOrNull { it.key == key }
                ?: return ActionResult(status = ActionStatus.FAILED, error = "notification not found")
            if (item.packageName == service.packageName) {
                return ActionResult(
                    status = ActionStatus.FAILED,
                    error = "operator governance notifications cannot be controlled",
                )
            }
            return try {
                when (action) {
                    "dismiss" -> service.cancelNotification(key)
                    "open" -> item.notification.contentIntent?.send()
                        ?: return ActionResult(status = ActionStatus.FAILED, error = "notification has no open action")
                    "invoke" -> {
                        val index = actionIndex
                            ?: return ActionResult(status = ActionStatus.FAILED, error = "actionIndex required")
                        item.notification.actions?.getOrNull(index)?.actionIntent?.send()
                            ?: return ActionResult(status = ActionStatus.FAILED, error = "notification action unavailable")
                    }
                    else -> return ActionResult(status = ActionStatus.UNSUPPORTED, error = "unknown notification action")
                }
                ActionResult(
                    status = ActionStatus.SUCCESS,
                    latencyMs = System.currentTimeMillis() - started,
                )
            } catch (error: Exception) {
                ActionResult(status = ActionStatus.FAILED, error = error.message)
            }
        }
    }

    override fun onListenerConnected() {
        running = this
    }

    override fun onListenerDisconnected() {
        if (running === this) running = null
    }

    override fun onDestroy() {
        if (running === this) running = null
        super.onDestroy()
    }
}

class MediaSessionController(private val context: Context) {
    private val component = ComponentName(context, OperatorNotificationListenerService::class.java)
    private val manager = context.getSystemService(MediaSessionManager::class.java)

    fun state(): MediaState {
        if (!hasAccess()) {
            return MediaState(available = false, permissionRequired = true)
        }
        val controllers = runCatching { manager.getActiveSessions(component) }.getOrElse {
            return MediaState(available = false, permissionRequired = true)
        }
        return MediaState(
            available = true,
            permissionRequired = false,
            sessions = controllers.map(::toState),
        )
    }

    fun control(action: String, packageName: String?): ActionResult {
        val started = System.currentTimeMillis()
        if (!hasAccess()) {
            return result(started, ActionStatus.UNSUPPORTED, "notification listener access required")
        }
        val controllers = runCatching { manager.getActiveSessions(component) }.getOrElse {
            return result(started, ActionStatus.FAILED, it.message ?: "media sessions unavailable")
        }
        val controller = selectController(controllers, packageName)
            ?: return result(started, ActionStatus.FAILED, "no matching active media session")
        val controls = controller.transportControls
        when (action) {
            "play" -> controls.play()
            "pause" -> controls.pause()
            "stop" -> controls.stop()
            "next" -> controls.skipToNext()
            "previous" -> controls.skipToPrevious()
            else -> return result(started, ActionStatus.UNSUPPORTED, "unknown media action $action")
        }
        return result(started, ActionStatus.SUCCESS)
    }

    private fun hasAccess(): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners",
        ) ?: return false
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == component }
    }

    private fun selectController(
        controllers: List<MediaController>,
        packageName: String?,
    ): MediaController? {
        if (packageName != null) return controllers.firstOrNull { it.packageName == packageName }
        return controllers.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING }
            ?: controllers.firstOrNull()
    }

    private fun toState(controller: MediaController): MediaSessionState {
        val playback = controller.playbackState
        val metadata = controller.metadata
        return MediaSessionState(
            packageName = controller.packageName,
            title = metadata?.getString(android.media.MediaMetadata.METADATA_KEY_TITLE)
                ?: metadata?.getString(android.media.MediaMetadata.METADATA_KEY_DISPLAY_TITLE),
            artist = metadata?.getString(android.media.MediaMetadata.METADATA_KEY_ARTIST)
                ?: metadata?.getString(android.media.MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE),
            album = metadata?.getString(android.media.MediaMetadata.METADATA_KEY_ALBUM),
            playbackState = playbackStateName(playback?.state),
            positionMs = playback?.position?.takeIf { it >= 0 },
            durationMs = if (metadata?.containsKey(android.media.MediaMetadata.METADATA_KEY_DURATION) == true) {
                metadata.getLong(android.media.MediaMetadata.METADATA_KEY_DURATION).takeIf { it >= 0 }
            } else {
                null
            },
            supportedActions = supportedActions(playback?.actions ?: 0),
        )
    }

    private fun playbackStateName(state: Int?): String = when (state) {
        null, PlaybackState.STATE_NONE -> "none"
        PlaybackState.STATE_STOPPED -> "stopped"
        PlaybackState.STATE_PAUSED -> "paused"
        PlaybackState.STATE_PLAYING -> "playing"
        PlaybackState.STATE_FAST_FORWARDING -> "fast_forwarding"
        PlaybackState.STATE_REWINDING -> "rewinding"
        PlaybackState.STATE_BUFFERING -> "buffering"
        PlaybackState.STATE_CONNECTING -> "connecting"
        PlaybackState.STATE_SKIPPING_TO_NEXT,
        PlaybackState.STATE_SKIPPING_TO_PREVIOUS,
        PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM -> "skipping"
        PlaybackState.STATE_ERROR -> "error"
        else -> "unknown"
    }

    private fun supportedActions(actions: Long): List<String> = buildList {
        if (actions and PlaybackState.ACTION_PLAY != 0L) add("play")
        if (actions and PlaybackState.ACTION_PAUSE != 0L) add("pause")
        if (actions and PlaybackState.ACTION_STOP != 0L) add("stop")
        if (actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L) add("next")
        if (actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L) add("previous")
        if (actions and PlaybackState.ACTION_SEEK_TO != 0L) add("seek")
    }

    private fun result(started: Long, status: ActionStatus, error: String? = null) = ActionResult(
        status = status,
        error = error,
        screenChanged = false,
        latencyMs = System.currentTimeMillis() - started,
    )
}

package dev.trueforge.operator

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.approvals.ApprovalCoordinator
import dev.trueforge.operator.networking.DeviceConnection
import dev.trueforge.operator.networking.DeviceConnectionService
import dev.trueforge.operator.networking.TaskRunClient
import dev.trueforge.operator.questions.QuestionCoordinator
import dev.trueforge.operator.snapshots.ActionResult
import dev.trueforge.operator.snapshots.ActionStatus
import dev.trueforge.operator.snapshots.ScreenSnapshot
import dev.trueforge.operator.snapshots.WireJson
import dev.trueforge.operator.ui.OperatorApp
import dev.trueforge.operator.ui.TaskUiState
import dev.trueforge.operator.ui.VoiceInputController
import dev.trueforge.operator.util.DeviceIdentity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private companion object {
        /** How long Stop waits for the server's run.failed before forcing idle. */
        const val STOP_GRACE_MS = 5_000
    }

    private var serviceRunning by mutableStateOf(false)
    private var serverUrl by mutableStateOf("")
    private var connectionState by mutableStateOf("disconnected")
    private var pendingApproval by mutableStateOf<ApprovalCoordinator.PendingApproval?>(null)
    private var pendingQuestion by mutableStateOf<QuestionCoordinator.PendingQuestion?>(null)
    private var task by mutableStateOf(TaskUiState())

    /** Phone-initiated runs go through the same server pipeline as the dashboard. */
    private val runClient by lazy {
        TaskRunClient(
            serverUrlProvider = { serverUrl },
            deviceIdProvider = { DeviceConnectionService.deviceId(this) },
        )
    }
    private var runJob: Job? = null
    private var agentEventCount = 0
    private var stopRequested = false
    private var stopCancellationSent = false
    private lateinit var voice: VoiceInputController

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The UI draws its own background and pads for the system bars, so the
        // task surface can run to the edges of the screen.
        enableEdgeToEdge()
        serverUrl = DeviceConnectionService.serverUrl(this)

        val permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) connect()
        }

        voice = VoiceInputController(this)
        task = task.copy(micAvailable = voice.isAvailable())
        val micPermissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { granted ->
            if (granted) {
                startDictation()
            } else {
                task = task.copy(
                    micError = "Microphone permission is needed to dictate a task. " +
                        "Type the task instead, or grant it in Settings.",
                )
            }
        }

        setContent {
            OperatorApp(
                serviceRunning = serviceRunning,
                serverUrl = serverUrl,
                onServerUrlChange = {
                    serverUrl = it
                    DeviceConnectionService.saveServerUrl(this, it.trim())
                },
                connectionState = connectionState,
                connected = connectionState.startsWith("connected"),
                onConnect = { ensureNotificationPermission(permissionLauncher) },
                onDisconnect = ::disconnect,
                onOpenAccessibilitySettings = ::openAccessibilitySettings,
                onOpenNotificationListenerSettings = ::openNotificationListenerSettings,
                onCaptureSnapshot = ::captureSnapshot,
                onClickNode = { nodeId -> actionResultJson { clickNode(nodeId) } },
                onSetText = { nodeId, text -> actionResultJson { setText(nodeId, text) } },
                onGlobalAction = { kind -> actionResultJson { globalAction(kind) } },
                deviceId = DeviceConnectionService.deviceId(this),
                pendingApproval = pendingApproval,
                onApprovalDecision = { requestId, decision ->
                    ApprovalCoordinator.resolve(this, requestId, decision, reason = null)
                },
                pendingQuestion = pendingQuestion,
                onQuestionAnswer = { requestId, answer ->
                    QuestionCoordinator.resolve(this, requestId, answer)
                },
                task = task,
                onTaskPromptChange = { task = task.copy(prompt = it) },
                onSendTask = ::sendTask,
                onStopTask = ::stopTask,
                onMicTap = { onMicTap(micPermissionLauncher) },
                onClearResult = ::clearRunSurface,
            )
        }

        observePendingApprovals()
        observePendingQuestions()
    }

    /** Clears the finished run so Home returns to its resting state. */
    private fun clearRunSurface() {
        if (task.runActive) return
        task = task.copy(statusLine = "", log = emptyList(), output = null, error = null)
    }

    // --- Task entry -------------------------------------------------------

    private fun sendTask() {
        val prompt = task.prompt.trim()
        if (prompt.isEmpty() || task.runActive) return
        voice.stop()
        stopRequested = false
        stopCancellationSent = false
        agentEventCount = 0
        task = task.copy(
            runActive = true,
            runId = null,
            statusLine = "Starting…",
            log = emptyList(),
            output = null,
            error = null,
            micError = null,
        )
        runJob = lifecycleScope.launch {
            try {
                runClient.start(prompt).collect(::applyRunEvent)
                // A stream that ends without a terminal envelope still has to
                // release the UI, or Send stays disabled forever.
                if (task.runActive) {
                    task = task.copy(
                        runActive = false,
                        statusLine = "Run ended",
                        error = task.error ?: "The run stream ended unexpectedly",
                    )
                }
            } catch (err: Throwable) {
                if (err is kotlinx.coroutines.CancellationException) throw err
                task = task.copy(
                    runActive = false,
                    statusLine = "Run failed",
                    error = err.message ?: err.javaClass.simpleName,
                )
            }
        }
    }

    private fun applyRunEvent(event: TaskRunClient.RunEvent) {
        if (stopRequested && !stopCancellationSent && event.runId != null) {
            stopCancellationSent = true
            lifecycleScope.launch {
                runCatching { runClient.cancel(event.runId) }
            }
        }
        if (event.type == "agent.event") agentEventCount += 1
        val statusLine = when (event.type) {
            "run.created" -> "Starting…"
            "run.started" -> "Agent working"
            "agent.event" -> event.summary?.let { "Calling $it" }
                ?: "Agent working ($agentEventCount events)"
            "approval.pending" -> "Waiting for your approval…"
            "question.pending" -> "Waiting for your answer…"
            "approval.decided" -> event.summary ?: "Approval decided"
            "run.completed" -> "Done"
            "run.failed" -> "Failed"
            else -> task.statusLine
        }
        val log = event.summary
            ?.let { (task.log + it).takeLast(20) }
            ?: task.log
        task = task.copy(
            runId = event.runId ?: task.runId,
            statusLine = statusLine,
            log = log,
            output = event.output ?: task.output,
            error = event.error ?: task.error,
            runActive = if (event.isTerminal) false else task.runActive,
        )
    }

    private fun stopTask() {
        val runId = task.runId
        stopRequested = true
        stopCancellationSent = runId != null
        task = task.copy(statusLine = "Stopping…")
        lifecycleScope.launch {
            try {
                if (runId != null) runClient.cancel(runId)
            } catch (err: Throwable) {
                if (err is kotlinx.coroutines.CancellationException) throw err
                // Cancel is best-effort; the local stream is torn down either way.
                task = task.copy(error = err.message ?: "Could not reach the server to cancel")
            }
            // The server ends the stream with run.failed "cancelled by user".
            // Give it a moment to arrive so the real reason is shown, then
            // drop the local collector so the UI cannot stay stuck.
            var waitedMs = 0
            while (task.runActive && waitedMs < STOP_GRACE_MS) {
                kotlinx.coroutines.delay(200)
                waitedMs += 200
            }
            runJob?.cancel()
            runJob = null
            if (task.runActive) {
                task = task.copy(runActive = false, statusLine = "Stopped")
            }
        }
    }

    // --- Voice ------------------------------------------------------------

    private fun onMicTap(launcher: ActivityResultLauncher<String>) {
        if (voice.listening) {
            voice.stop()
            syncVoiceState()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            launcher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        startDictation()
    }

    /**
     * The transcript lands in the field, editable — it is never auto-sent.
     * A mis-heard command going straight to an agent that drives the phone
     * would defeat the approval gate this product is built around.
     */
    private fun startDictation() {
        task = task.copy(micError = null)
        voice.start(
            onPartial = { partial ->
                task = task.copy(prompt = partial, micListening = true)
            },
            onFinal = { transcript ->
                task = task.copy(prompt = transcript, micListening = false)
            },
        )
        syncVoiceState()
        lifecycleScope.launch {
            // The recognizer reports listening/error through its own state;
            // mirror it into the UI model until the session ends.
            while (voice.listening) {
                syncVoiceState()
                kotlinx.coroutines.delay(150)
            }
            syncVoiceState()
        }
    }

    private fun syncVoiceState() {
        task = task.copy(micListening = voice.listening, micError = voice.error ?: task.micError)
    }

    override fun onDestroy() {
        voice.destroy()
        super.onDestroy()
    }

    private fun observePendingApprovals() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                ApprovalCoordinator.pending.collect { pendingApproval = it }
            }
        }
    }

    private fun observePendingQuestions() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                QuestionCoordinator.pending.collect { pendingQuestion = it }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        serviceRunning = OperatorAccessibilityService.isRunning()
        observeConnectionState()
    }

    private fun ensureNotificationPermission(launcher: ActivityResultLauncher<String>) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            connect()
        }
    }

    private fun connect() {
        DeviceConnectionService.saveServerUrl(this, serverUrl.trim())
        DeviceConnectionService.start(this)
    }

    private fun disconnect() {
        DeviceConnectionService.stop(this)
    }

    private fun observeConnectionState() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                DeviceConnectionService.connectionState.collect { state: DeviceConnection.State? ->
                    connectionState = when (state) {
                        is DeviceConnection.State.Connected -> "connected"
                        is DeviceConnection.State.Connecting ->
                            "connecting (attempt ${(state as DeviceConnection.State.Connecting).attempt})"
                        is DeviceConnection.State.Disconnected -> "disconnected; retrying"
                        null -> "disconnected"
                    }
                    // Refresh accessibility status too, in case it changed.
                    serviceRunning = OperatorAccessibilityService.isRunning()
                }
            }
        }
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    private fun openNotificationListenerSettings() {
        startActivity(Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS"))
    }

    private fun captureSnapshot(): String = try {
        val snapshot = OperatorAccessibilityService.requireService()
            .captureSnapshot(DeviceIdentity.deviceId(this))
        WireJson.json.encodeToString(ScreenSnapshot.serializer(), snapshot)
    } catch (err: Throwable) {
        errorJson(err)
    }

    private suspend fun actionResultJson(
        block: suspend OperatorAccessibilityService.() -> ActionResult,
    ): String = try {
        val result = withContext(Dispatchers.Default) {
            block(OperatorAccessibilityService.requireService())
        }
        WireJson.json.encodeToString(ActionResult.serializer(), result)
    } catch (err: Throwable) {
        errorJson(err)
    }

    private fun errorJson(err: Throwable): String = WireJson.json.encodeToString(
        ActionResult.serializer(),
        ActionResult(
            status = ActionStatus.FAILED,
            error = err.message ?: err.javaClass.simpleName,
        ),
    )
}

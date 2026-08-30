package dev.trueforge.operator.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.activity.compose.BackHandler
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.approvals.ApprovalCoordinator
import dev.trueforge.operator.questions.QuestionCoordinator
import dev.trueforge.operator.ui.theme.PillShape
import dev.trueforge.operator.ui.theme.TrueForgeTheme

/**
 * Everything the task card on the phone needs to render. Held by
 * MainActivity, which owns the run coroutine and the recognizer.
 */
data class TaskUiState(
    val prompt: String = "",
    val runActive: Boolean = false,
    val runId: String? = null,
    val statusLine: String = "",
    val log: List<String> = emptyList(),
    val output: String? = null,
    val error: String? = null,
    val micAvailable: Boolean = false,
    val micListening: Boolean = false,
    val micError: String? = null,
)

private enum class Screen { Home, Settings }

/**
 * App shell: theme, the two screens, and the two modal interrupts.
 *
 * The split is the point. Home is a voice-first task surface with nothing on
 * it but the task and its run; every knob — permissions, the bridge URL, the
 * raw accessibility probes — lives behind Settings, because a user opens this
 * app to say a sentence, not to read a configuration report.
 */
@Composable
fun OperatorApp(
    serviceRunning: Boolean,
    serverUrl: String,
    onServerUrlChange: (String) -> Unit,
    connectionState: String,
    connected: Boolean,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onOpenNotificationListenerSettings: () -> Unit,
    onCaptureSnapshot: () -> String,
    onClickNode: suspend (String) -> String,
    onSetText: suspend (String, String) -> String,
    onGlobalAction: suspend (OperatorAccessibilityService.GlobalActionKind) -> String,
    deviceId: String = "",
    pendingApproval: ApprovalCoordinator.PendingApproval? = null,
    onApprovalDecision: (String, String) -> Unit = { _, _ -> },
    pendingQuestion: QuestionCoordinator.PendingQuestion? = null,
    onQuestionAnswer: (String, String?) -> Unit = { _, _ -> },
    task: TaskUiState = TaskUiState(),
    onTaskPromptChange: (String) -> Unit = {},
    onSendTask: () -> Unit = {},
    onStopTask: () -> Unit = {},
    onMicTap: () -> Unit = {},
    onClearResult: () -> Unit = {},
) {
    TrueForgeTheme {
        var screen by remember { mutableStateOf(Screen.Home) }
        val ready = connected && serviceRunning

        BackHandler(enabled = screen == Screen.Settings) { screen = Screen.Home }

        Surface(
            modifier = Modifier.fillMaxSize(),
            color = MaterialTheme.colorScheme.background,
        ) {
            AnimatedContent(
                targetState = screen,
                transitionSpec = {
                    val forward = targetState == Screen.Settings
                    val width = { w: Int -> if (forward) w else -w }
                    (slideInHorizontally(tween(260), width) + fadeIn(tween(180)))
                        .togetherWith(
                            slideOutHorizontally(tween(260)) { -width(it) } + fadeOut(tween(180)),
                        )
                },
                label = "screen",
                modifier = Modifier
                    .fillMaxSize()
                    .safeDrawingPadding(),
            ) { current ->
                when (current) {
                    Screen.Home -> HomeScreen(
                        task = task,
                        ready = ready,
                        readinessLabel = readinessLabel(task, ready, serviceRunning, connected),
                        readinessDetail = readinessDetail(task, ready, serviceRunning, connected),
                        onOpenSettings = { screen = Screen.Settings },
                        onPromptChange = onTaskPromptChange,
                        onSend = onSendTask,
                        onStop = onStopTask,
                        onMicTap = onMicTap,
                        onClearResult = onClearResult,
                    )

                    Screen.Settings -> SettingsScreen(
                        serviceRunning = serviceRunning,
                        connected = connected,
                        connectionState = connectionState,
                        serverUrl = serverUrl,
                        deviceId = deviceId,
                        onServerUrlChange = onServerUrlChange,
                        onConnect = onConnect,
                        onDisconnect = onDisconnect,
                        onOpenAccessibilitySettings = onOpenAccessibilitySettings,
                        onOpenNotificationListenerSettings = onOpenNotificationListenerSettings,
                        onCaptureSnapshot = onCaptureSnapshot,
                        onClickNode = onClickNode,
                        onSetText = onSetText,
                        onGlobalAction = onGlobalAction,
                        onBack = { screen = Screen.Home },
                    )
                }
            }
        }

        if (pendingApproval != null) {
            ApprovalDialog(
                pending = pendingApproval,
                onDecision = { decision -> onApprovalDecision(pendingApproval.requestId, decision) },
            )
        }
        if (pendingQuestion != null) {
            QuestionDialog(
                pending = pendingQuestion,
                onAnswer = { answer -> onQuestionAnswer(pendingQuestion.requestId, answer) },
            )
        }
    }
}

/**
 * One word for the whole stack. A run in flight outranks readiness, and when
 * two things are missing the accessibility runtime is named first because
 * connecting without it gets you nowhere.
 */
private fun readinessLabel(
    task: TaskUiState,
    ready: Boolean,
    serviceRunning: Boolean,
    connected: Boolean,
): String = when {
    task.runActive -> "Working"
    ready -> "Ready"
    !serviceRunning -> "Runtime off"
    !connected -> "Not connected"
    else -> "Not ready"
}

private fun readinessDetail(
    task: TaskUiState,
    ready: Boolean,
    serviceRunning: Boolean,
    connected: Boolean,
): String? = when {
    task.runActive -> null
    ready -> null
    !serviceRunning -> "tap to enable"
    !connected -> "tap to connect"
    else -> null
}

/**
 * In-app mirror of the approval notification. Both resolve the same request;
 * the first decision wins. Dismissal is deliberately not a decision — the
 * server's timeout is what denies.
 */
@Composable
private fun ApprovalDialog(
    pending: ApprovalCoordinator.PendingApproval,
    onDecision: (String) -> Unit,
) {
    var showDetails by remember(pending.requestId) { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = {},
        shape = MaterialTheme.shapes.extraLarge,
        containerColor = MaterialTheme.colorScheme.surface,
        title = { Text("Approve this action?", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(pending.intent, style = MaterialTheme.typography.bodyLarge)
                TextButton(
                    onClick = { showDetails = !showDetails },
                    contentPadding = ButtonDefaults.TextButtonWithIconContentPadding,
                ) {
                    Text(if (showDetails) "Hide details" else "Show details")
                }
                if (showDetails) {
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            pending.actionJson.take(2000),
                            style = MaterialTheme.typography.bodySmall
                                .copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(onClick = { onDecision("allow") }, shape = PillShape) { Text("Allow") }
        },
        dismissButton = {
            OutlinedButton(onClick = { onDecision("deny") }, shape = PillShape) { Text("Deny") }
        },
    )
}

@Composable
private fun QuestionDialog(
    pending: QuestionCoordinator.PendingQuestion,
    onAnswer: (String?) -> Unit,
) {
    var selected by remember(pending.requestId) { mutableStateOf<String?>(null) }
    var freeText by remember(pending.requestId) { mutableStateOf("") }
    val answer = freeText.trim().takeIf { it.isNotEmpty() } ?: selected

    AlertDialog(
        onDismissRequest = {},
        shape = MaterialTheme.shapes.extraLarge,
        containerColor = MaterialTheme.colorScheme.surface,
        title = { Text("One question", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(pending.question, style = MaterialTheme.typography.bodyLarge)
                pending.options.forEach { option ->
                    val isSelected = selected == option && freeText.isBlank()
                    Surface(
                        onClick = {
                            selected = option
                            freeText = ""
                        },
                        shape = MaterialTheme.shapes.medium,
                        color = if (isSelected) MaterialTheme.colorScheme.primaryContainer
                        else MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Row(
                            modifier = Modifier.padding(end = 12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = isSelected, onClick = null)
                            Text(option, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                OutlinedTextField(
                    value = freeText,
                    onValueChange = {
                        freeText = it
                        if (it.isNotBlank()) selected = null
                    },
                    label = { Text("Or type your answer") },
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onAnswer(answer) },
                enabled = answer != null,
                shape = PillShape,
            ) { Text("Submit") }
        },
        dismissButton = {
            OutlinedButton(onClick = { onAnswer(null) }, shape = PillShape) { Text("Cancel run") }
        },
    )
}

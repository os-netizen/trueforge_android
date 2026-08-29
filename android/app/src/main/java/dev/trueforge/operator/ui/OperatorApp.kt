package dev.trueforge.operator.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.approvals.ApprovalCoordinator
import dev.trueforge.operator.questions.QuestionCoordinator
import kotlinx.coroutines.launch

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

/**
 * Milestone 3 app surface: connection controls + local dev tools.
 * Brief 03 adds the task card on top — the phone is the primary surface for
 * starting and stopping a run; the dashboard stays the rich observability one.
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
    pendingApproval: ApprovalCoordinator.PendingApproval? = null,
    onApprovalDecision: (String, String) -> Unit = { _, _ -> },
    pendingQuestion: QuestionCoordinator.PendingQuestion? = null,
    onQuestionAnswer: (String, String?) -> Unit = { _, _ -> },
    task: TaskUiState = TaskUiState(),
    onTaskPromptChange: (String) -> Unit = {},
    onSendTask: () -> Unit = {},
    onStopTask: () -> Unit = {},
    onMicTap: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    val scroll = rememberScrollState()
    var snapshotJson by remember { mutableStateOf("") }
    var resultJson by remember { mutableStateOf("") }
    var nodeIdInput by remember { mutableStateOf("n1") }
    var textInput by remember { mutableStateOf("") }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("TrueForge Operator", style = MaterialTheme.typography.headlineSmall)

        TaskCard(
            task = task,
            canSend = connected && serviceRunning,
            onPromptChange = onTaskPromptChange,
            onSend = onSendTask,
            onStop = onStopTask,
            onMicTap = onMicTap,
        )

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    if (serviceRunning) "Accessibility runtime: ACTIVE"
                    else "Accessibility runtime: NOT ENABLED",
                    style = MaterialTheme.typography.titleMedium,
                )
                OutlinedButton(onClick = onOpenAccessibilitySettings) {
                    Text("Open accessibility settings")
                }
                OutlinedButton(onClick = onOpenNotificationListenerSettings) {
                    Text("Enable media session access")
                }
            }
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    "Agent connection: $connectionState",
                    style = MaterialTheme.typography.titleMedium,
                    color = if (connected) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.error,
                )
                OutlinedTextField(
                    value = serverUrl,
                    onValueChange = onServerUrlChange,
                    label = { Text("bridge server url") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onConnect, enabled = serviceRunning && !connected) {
                        Text("Connect")
                    }
                    OutlinedButton(onClick = onDisconnect, enabled = connected) {
                        Text("Disconnect")
                    }
                }
            }
        }

        Button(
            onClick = { snapshotJson = onCaptureSnapshot() },
            enabled = serviceRunning,
        ) {
            Text("Capture screen snapshot")
        }

        if (snapshotJson.isNotEmpty()) {
            JsonCard("Snapshot", snapshotJson)
        }

        OutlinedTextField(
            value = nodeIdInput,
            onValueChange = { nodeIdInput = it },
            label = { Text("node id") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    scope.launch { resultJson = onClickNode(nodeIdInput) }
                },
                enabled = serviceRunning,
            ) {
                Text("Click node")
            }
        }

        OutlinedTextField(
            value = textInput,
            onValueChange = { textInput = it },
            label = { Text("text to set") },
            modifier = Modifier.fillMaxWidth(),
            singleLine = true,
        )

        Button(
            onClick = {
                scope.launch { resultJson = onSetText(nodeIdInput, textInput) }
            },
            enabled = serviceRunning,
        ) {
            Text("Set text")
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(
                onClick = {
                    scope.launch {
                        resultJson =
                            onGlobalAction(OperatorAccessibilityService.GlobalActionKind.BACK)
                    }
                },
                enabled = serviceRunning,
            ) { Text("Back") }
            OutlinedButton(
                onClick = {
                    scope.launch {
                        resultJson =
                            onGlobalAction(OperatorAccessibilityService.GlobalActionKind.HOME)
                    }
                },
                enabled = serviceRunning,
            ) { Text("Home") }
        }

        if (resultJson.isNotEmpty()) {
            JsonCard("Action result", resultJson)
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

/**
 * Task entry, live run status, and Stop. Send stays disabled while
 * disconnected, while the accessibility runtime is off, and for the whole of
 * an active run: one task at a time keeps the phone's state legible.
 */
@Composable
private fun TaskCard(
    task: TaskUiState,
    canSend: Boolean,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicTap: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text("Task", style = MaterialTheme.typography.titleMedium)

            OutlinedTextField(
                value = task.prompt,
                onValueChange = onPromptChange,
                label = { Text(if (task.micListening) "Listening…" else "What should the agent do?") },
                modifier = Modifier.fillMaxWidth(),
                minLines = 2,
                enabled = !task.runActive,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // Hidden entirely when the device has no recognizer, rather
                // than offering a button that can only fail.
                if (task.micAvailable) {
                    OutlinedButton(
                        onClick = onMicTap,
                        enabled = !task.runActive,
                    ) {
                        Text(if (task.micListening) "◉ Listening…" else "🎤 Speak")
                    }
                }
                Button(
                    onClick = onSend,
                    enabled = canSend && !task.runActive && task.prompt.isNotBlank(),
                ) {
                    Text("Send")
                }
                if (task.runActive) {
                    Button(
                        onClick = onStop,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.error,
                        ),
                    ) {
                        Text("Stop")
                    }
                }
            }

            if (task.micError != null) {
                Text(
                    task.micError,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }

            if (!canSend && !task.runActive) {
                Text(
                    "Connect the agent and enable the accessibility runtime to send a task.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            if (task.statusLine.isNotEmpty()) {
                Text(task.statusLine, style = MaterialTheme.typography.bodyMedium)
            }

            if (task.log.isNotEmpty()) {
                Text(
                    task.log.joinToString("\n"),
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            if (task.output != null) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text("Result", style = MaterialTheme.typography.titleSmall)
                        Text(task.output.take(4000), style = MaterialTheme.typography.bodyMedium)
                    }
                }
            }

            if (task.error != null) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(
                            "Failed",
                            style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.error,
                        )
                        Text(
                            task.error.take(2000),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.error,
                        )
                    }
                }
            }
        }
    }
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
        title = { Text("Approve this action?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(pending.intent, style = MaterialTheme.typography.bodyLarge)
                TextButton(onClick = { showDetails = !showDetails }) {
                    Text(if (showDetails) "Hide details" else "Show details")
                }
                if (showDetails) {
                    Text(
                        pending.actionJson.take(2000),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = { onDecision("allow") }) { Text("Allow") }
        },
        dismissButton = {
            OutlinedButton(onClick = { onDecision("deny") }) { Text("Deny") }
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
        title = { Text("Agent needs your input") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(pending.question, style = MaterialTheme.typography.bodyLarge)
                pending.options.forEach { option ->
                    Row(modifier = Modifier.fillMaxWidth()) {
                        RadioButton(
                            selected = selected == option && freeText.isBlank(),
                            onClick = {
                                selected = option
                                freeText = ""
                            },
                        )
                        TextButton(onClick = {
                            selected = option
                            freeText = ""
                        }) { Text(option) }
                    }
                }
                OutlinedTextField(
                    value = freeText,
                    onValueChange = {
                        freeText = it
                        if (it.isNotBlank()) selected = null
                    },
                    label = { Text("Or type your answer") },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(onClick = { onAnswer(answer) }, enabled = answer != null) { Text("Submit") }
        },
        dismissButton = {
            OutlinedButton(onClick = { onAnswer(null) }) { Text("Cancel run") }
        },
    )
}

@Composable
private fun JsonCard(title: String, json: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(json.take(6000), style = MaterialTheme.typography.bodySmall)
        }
    }
}

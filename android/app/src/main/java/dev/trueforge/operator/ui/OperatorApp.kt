package dev.trueforge.operator.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import kotlinx.coroutines.launch

/**
 * Milestone 3 app surface: connection controls + local dev tools.
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
    onCaptureSnapshot: () -> String,
    onClickNode: suspend (String) -> String,
    onSetText: suspend (String, String) -> String,
    onGlobalAction: suspend (OperatorAccessibilityService.GlobalActionKind) -> String,
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

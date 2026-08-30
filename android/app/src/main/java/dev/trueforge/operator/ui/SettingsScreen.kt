package dev.trueforge.operator.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.trueforge.operator.accessibility.OperatorAccessibilityService
import dev.trueforge.operator.ui.theme.ColorSchemeReady
import dev.trueforge.operator.ui.theme.PillShape
import kotlinx.coroutines.launch

/**
 * Everything that used to crowd the main screen.
 *
 * Ordered by how often it is touched: the two things that gate a run first,
 * the bridge address second, and the raw accessibility probes last, folded
 * away behind a disclosure so a normal user never sees them.
 */
@Composable
fun SettingsScreen(
    serviceRunning: Boolean,
    connected: Boolean,
    connectionState: String,
    serverUrl: String,
    deviceId: String,
    onServerUrlChange: (String) -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onOpenNotificationListenerSettings: () -> Unit,
    onCaptureSnapshot: () -> String,
    onClickNode: suspend (String) -> String,
    onSetText: suspend (String, String) -> String,
    onGlobalAction: suspend (OperatorAccessibilityService.GlobalActionKind) -> String,
    onBack: () -> Unit,
) {
    val scroll = rememberScrollState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll)
            .padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.padding(end = 4.dp)) {
                GlyphIcon(
                    OperatorIcons.Back,
                    "Back",
                    tint = MaterialTheme.colorScheme.onSurface,
                )
            }
            Text("Settings", style = MaterialTheme.typography.headlineSmall)
        }

        Section("Permissions") {
            SettingRow(
                label = "Accessibility runtime",
                supporting = if (serviceRunning) {
                    "Active — the agent can read and act on the screen"
                } else {
                    "Off — the agent cannot see or touch anything yet"
                },
                trailing = {
                    StatusDot(
                        tint = if (serviceRunning) ColorSchemeReady
                        else MaterialTheme.colorScheme.error,
                    )
                },
            )
            OutlinedButton(
                onClick = onOpenAccessibilitySettings,
                shape = PillShape,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (serviceRunning) "Open accessibility settings" else "Turn it on")
            }
            Divider()
            SettingRow(
                label = "Media session access",
                supporting = "Lets the agent control playback for media tasks",
            )
            OutlinedButton(
                onClick = onOpenNotificationListenerSettings,
                shape = PillShape,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Grant media access")
            }
        }

        Section("Agent connection") {
            SettingRow(
                label = "Bridge",
                supporting = connectionState,
                trailing = {
                    StatusDot(
                        tint = if (connected) ColorSchemeReady
                        else MaterialTheme.colorScheme.error,
                        pulsing = connectionState.startsWith("connecting"),
                    )
                },
            )
            OutlinedTextField(
                value = serverUrl,
                onValueChange = onServerUrlChange,
                label = { Text("Server URL") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = MaterialTheme.shapes.medium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Button(
                    onClick = onConnect,
                    enabled = serviceRunning && !connected,
                    shape = PillShape,
                    modifier = Modifier.weight(1f),
                ) { Text("Connect") }
                OutlinedButton(
                    onClick = onDisconnect,
                    enabled = connected,
                    shape = PillShape,
                    modifier = Modifier.weight(1f),
                ) { Text("Disconnect") }
            }
            if (!serviceRunning) {
                Text(
                    "Enable the accessibility runtime first — connecting without it " +
                        "gives the agent nothing to drive.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Section("Device") {
            SettingRow(label = "Device ID", supporting = deviceId)
        }

        DeveloperTools(
            serviceRunning = serviceRunning,
            onCaptureSnapshot = onCaptureSnapshot,
            onClickNode = onClickNode,
            onSetText = onSetText,
            onGlobalAction = onGlobalAction,
        )

        Spacer(Modifier.height(24.dp))
    }
}

/**
 * The old main-screen probes, kept because they are the fastest way to tell a
 * broken accessibility tree from a broken bridge — but collapsed, because they
 * are diagnostics rather than settings.
 */
@Composable
private fun DeveloperTools(
    serviceRunning: Boolean,
    onCaptureSnapshot: () -> String,
    onClickNode: suspend (String) -> String,
    onSetText: suspend (String, String) -> String,
    onGlobalAction: suspend (OperatorAccessibilityService.GlobalActionKind) -> String,
) {
    val scope = rememberCoroutineScope()
    var expanded by remember { mutableStateOf(false) }
    var nodeId by remember { mutableStateOf("n1") }
    var textValue by remember { mutableStateOf("") }
    var output by remember { mutableStateOf("") }
    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 90f else -90f,
        label = "chevron",
    )

    Column(Modifier.fillMaxWidth()) {
        Surface(
            onClick = { expanded = !expanded },
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Row(
                modifier = Modifier.padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("Developer tools", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Snapshot the screen and fire raw accessibility actions",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Icon(
                    OperatorIcons.Back,
                    contentDescription = null,
                    modifier = Modifier
                        .size(18.dp)
                        .rotate(chevronRotation),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        AnimatedVisibility(visible = expanded) {
            Column(
                modifier = Modifier.padding(top = 12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    onClick = { output = onCaptureSnapshot() },
                    enabled = serviceRunning,
                    shape = PillShape,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Capture screen snapshot") }

                OutlinedTextField(
                    value = nodeId,
                    onValueChange = { nodeId = it },
                    label = { Text("Node ID") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = MaterialTheme.shapes.medium,
                )
                OutlinedTextField(
                    value = textValue,
                    onValueChange = { textValue = it },
                    label = { Text("Text to set") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    shape = MaterialTheme.shapes.medium,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = { scope.launch { output = onClickNode(nodeId) } },
                        enabled = serviceRunning,
                        shape = PillShape,
                        modifier = Modifier.weight(1f),
                    ) { Text("Click node") }
                    OutlinedButton(
                        onClick = { scope.launch { output = onSetText(nodeId, textValue) } },
                        enabled = serviceRunning,
                        shape = PillShape,
                        modifier = Modifier.weight(1f),
                    ) { Text("Set text") }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                output = onGlobalAction(
                                    OperatorAccessibilityService.GlobalActionKind.BACK,
                                )
                            }
                        },
                        enabled = serviceRunning,
                        shape = PillShape,
                        modifier = Modifier.weight(1f),
                    ) { Text("Back") }
                    OutlinedButton(
                        onClick = {
                            scope.launch {
                                output = onGlobalAction(
                                    OperatorAccessibilityService.GlobalActionKind.HOME,
                                )
                            }
                        },
                        enabled = serviceRunning,
                        shape = PillShape,
                        modifier = Modifier.weight(1f),
                    ) { Text("Home") }
                }

                if (output.isNotEmpty()) {
                    Surface(
                        shape = MaterialTheme.shapes.medium,
                        color = MaterialTheme.colorScheme.surfaceVariant,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.padding(14.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    "Output",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.weight(1f),
                                )
                                TextButton(
                                    onClick = { output = "" },
                                    contentPadding = ButtonDefaults.TextButtonContentPadding,
                                ) { Text("Clear") }
                            }
                            Text(
                                output.take(6000),
                                style = MaterialTheme.typography.bodySmall
                                    .copy(fontFamily = FontFamily.Monospace),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Hairline between rows inside a [Section]. */
@Composable
private fun Divider() {
    Box(
        Modifier
            .fillMaxWidth()
            .height(1.dp)
            .background(MaterialTheme.colorScheme.outlineVariant),
    )
}

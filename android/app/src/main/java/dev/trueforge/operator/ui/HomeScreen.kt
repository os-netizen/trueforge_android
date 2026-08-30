package dev.trueforge.operator.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.trueforge.operator.ui.theme.ColorSchemeReady
import dev.trueforge.operator.ui.theme.PillShape
import kotlinx.coroutines.delay

/**
 * The only screen most sessions ever need: say what you want, watch it happen.
 *
 * Configuration deliberately does not live here. Everything on this screen is
 * either the task you are dictating or the run it produced; the readiness pill
 * is the single line of plumbing, and it doubles as the way into Settings when
 * something is actually wrong.
 */
@Composable
fun HomeScreen(
    task: TaskUiState,
    ready: Boolean,
    readinessLabel: String,
    readinessDetail: String?,
    onOpenSettings: () -> Unit,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicTap: () -> Unit,
    onClearResult: () -> Unit,
    onNewTask: () -> Unit,
) {
    val hasRunSurface = task.hasRunSurface

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp),
    ) {
        HomeHeader(onOpenSettings = onOpenSettings)

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusPill(
                label = readinessLabel,
                detail = readinessDetail,
                tint = when {
                    task.runActive -> MaterialTheme.colorScheme.primary
                    ready -> ColorSchemeReady
                    else -> MaterialTheme.colorScheme.error
                },
                container = if (ready || task.runActive) MaterialTheme.colorScheme.surface
                else MaterialTheme.colorScheme.errorContainer,
                pulsing = task.runActive,
                modifier = Modifier.clickable(enabled = !ready) { onOpenSettings() },
            )
            Spacer(Modifier.weight(1f))
            // Only once there is something to clear. Mid-run the button in
            // this corner would compete with Stop, which is the real answer
            // to "I want out of this".
            AnimatedVisibility(
                visible = task.canStartNewTask,
                enter = fadeIn(),
                exit = fadeOut(),
            ) {
                NewTaskButton(onClick = onNewTask)
            }
        }

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(top = 20.dp),
            contentAlignment = Alignment.Center,
        ) {
            if (hasRunSurface) {
                RunPanel(task = task, onClearResult = onClearResult)
            } else {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(36.dp),
                ) {
                    MicHero(
                        listening = task.micListening,
                        available = task.micAvailable,
                        onTap = onMicTap,
                    )
                    if (task.prompt.isBlank() && !task.micListening) {
                        SuggestionList(onPick = onPromptChange)
                    }
                }
            }
        }

        if (task.micError != null) {
            Text(
                task.micError,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(bottom = 8.dp, start = 4.dp),
            )
        }

        Composer(
            task = task,
            ready = ready,
            offerMic = hasRunSurface,
            onPromptChange = onPromptChange,
            onSend = onSend,
            onStop = onStop,
            onMicTap = onMicTap,
        )

        Spacer(Modifier.height(8.dp))
    }
}

/**
 * Openers, not features. A blank screen is the hardest thing to speak into, so
 * the idle state offers three shapes of task that this agent actually handles
 * — tapping one loads it for editing rather than running it.
 */
private val SUGGESTIONS = listOf(
    "Open WhatsApp and message Omkar",
    "Play something on Spotify",
    "Book a cab to the airport",
)

/**
 * The way back to an empty screen. Deliberately a labelled pill rather than
 * another glyph: "start over" is not something anyone should have to guess at
 * from an icon, and the result card's small dismiss cross clearly did not say
 * it.
 */
@Composable
private fun NewTaskButton(onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = PillShape,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                OperatorIcons.Plus,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Text(
                "New task",
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.primary,
            )
        }
    }
}

@Composable
private fun HomeHeader(onOpenSettings: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                "TrueForge",
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onBackground,
            )
            Text(
                "Operator",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        IconButton(onClick = onOpenSettings) {
            GlyphIcon(OperatorIcons.Sliders, "Settings")
        }
    }
}

/**
 * The idle centrepiece. Two expanding rings while the recognizer is live give
 * the only feedback that matters mid-sentence: it is still hearing you.
 */
@Composable
private fun MicHero(
    listening: Boolean,
    available: Boolean,
    onTap: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            if (listening) {
                PulseRing(delayMillis = 0)
                PulseRing(delayMillis = 900)
            }
            val diameter by animateDpAsState(
                targetValue = if (listening) 128.dp else 116.dp,
                animationSpec = tween(320, easing = FastOutSlowInEasing),
                label = "micSize",
            )
            Surface(
                onClick = onTap,
                enabled = available,
                shape = RoundedCornerShape(percent = 50),
                color = if (listening) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.surface,
                border = BorderStroke(
                    1.dp,
                    if (listening) Color.Transparent else MaterialTheme.colorScheme.outline,
                ),
                modifier = Modifier.size(diameter),
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Icon(
                        OperatorIcons.Mic,
                        contentDescription = if (listening) "Stop listening" else "Speak a task",
                        modifier = Modifier.size(44.dp),
                        tint = if (listening) MaterialTheme.colorScheme.onPrimary
                        else MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                when {
                    !available -> "Type a task"
                    listening -> "Listening…"
                    else -> "Tap to speak"
                },
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                if (available) "or type it below" else "no speech recognizer on this device",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun PulseRing(delayMillis: Int) {
    val transition = rememberInfiniteTransition(label = "pulse")
    val progress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1800, delayMillis = delayMillis, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "pulseProgress",
    )
    Box(
        Modifier
            .size(128.dp)
            .graphicsLayer {
                val s = 1f + progress * 0.55f
                scaleX = s
                scaleY = s
                alpha = (1f - progress) * 0.35f
            }
            .clip(RoundedCornerShape(percent = 50))
            .background(MaterialTheme.colorScheme.primary),
    )
}

/**
 * Live run surface: what the agent is doing now, every step it took to get
 * there, and the final answer. Scrolls independently so the composer never
 * moves, and follows the newest step so the phone can be watched hands-off.
 */
@Composable
private fun RunPanel(task: TaskUiState, onClearResult: () -> Unit) {
    val scroll = rememberScrollState()

    // Chronological, newest last — the reading order everyone already has for
    // a transcript — so following it means staying pinned to the bottom.
    LaunchedEffect(task.steps.size, task.output, task.error) {
        scroll.animateScrollTo(scroll.maxValue)
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        RunHeader(task)

        if (task.steps.isNotEmpty()) {
            Column(Modifier.fillMaxWidth()) {
                task.steps.forEachIndexed { index, step ->
                    StepRow(
                        step = step,
                        isLast = index == task.steps.lastIndex,
                        isCurrent = task.runActive && index == task.steps.lastIndex,
                    )
                }
            }
        }

        AnimatedVisibility(
            visible = task.output != null,
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            ResultCard(
                title = "Result",
                body = task.output.orEmpty().take(4000),
                accent = MaterialTheme.colorScheme.onSurface,
                onDismiss = onClearResult,
            )
        }

        AnimatedVisibility(
            visible = task.error != null,
            enter = fadeIn(),
            exit = fadeOut(),
        ) {
            ResultCard(
                title = "Failed",
                body = task.error.orEmpty().take(2000),
                accent = MaterialTheme.colorScheme.error,
                onDismiss = onClearResult,
            )
        }

        Spacer(Modifier.height(4.dp))
    }
}

/** What the agent is doing right now, and how long it has been at it. */
@Composable
private fun RunHeader(task: TaskUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(
            task.statusLine.ifEmpty { if (task.runActive) "Working" else "Finished" },
            style = MaterialTheme.typography.titleMedium,
        )
        Text(
            runSubtitle(task),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** "8 steps · 1m 04s" — the two numbers worth glancing at mid-run. */
@Composable
private fun runSubtitle(task: TaskUiState): String {
    val steps = task.steps.count { it.kind == RunStep.Kind.Tool }
    val stepText = when (steps) {
        0 -> "no steps yet"
        1 -> "1 step"
        else -> "$steps steps"
    }
    val startedAt = task.startedAtMs ?: return stepText

    // Recomposes once a second while the run is live, and freezes the moment
    // it ends so the final duration stays on screen.
    var nowMs by remember(startedAt) { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(startedAt, task.runActive) {
        while (task.runActive) {
            nowMs = System.currentTimeMillis()
            delay(1000)
        }
        nowMs = System.currentTimeMillis()
    }
    return "$stepText · ${formatElapsed(nowMs - startedAt)}"
}

private fun formatElapsed(millis: Long): String {
    val seconds = (millis / 1000).coerceAtLeast(0)
    return if (seconds < 60) "${seconds}s" else "${seconds / 60}m ${"%02d".format(seconds % 60)}s"
}

/**
 * One timeline entry: a rail dot joined to the next by a hairline, the human
 * description, and the tool that produced it in a monospace chip for anyone
 * who wants to match it against the dashboard.
 */
@Composable
private fun StepRow(step: RunStep, isLast: Boolean, isCurrent: Boolean) {
    val accent = when (step.kind) {
        RunStep.Kind.Prompt -> MaterialTheme.colorScheme.primary
        RunStep.Kind.Tool ->
            if (isCurrent) MaterialTheme.colorScheme.primary
            else MaterialTheme.colorScheme.outline
        RunStep.Kind.Approval, RunStep.Kind.Question -> MaterialTheme.colorScheme.primary
        RunStep.Kind.Failure -> MaterialTheme.colorScheme.error
    }
    // IntrinsicSize.Min gives the row a height before its children are laid
    // out, which is what lets the rail fill it — a weighted connector inside
    // a wrap-content column measures to zero and draws nothing.
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min),
    ) {
        Column(
            modifier = Modifier
                .width(22.dp)
                .fillMaxHeight(),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Box(Modifier.padding(top = 5.dp)) {
                StatusDot(tint = accent, pulsing = isCurrent, size = if (isCurrent) 9 else 7)
            }
            if (!isLast) {
                Box(
                    Modifier
                        .width(1.dp)
                        .weight(1f)
                        .padding(top = 4.dp)
                        .background(MaterialTheme.colorScheme.outline),
                )
            }
        }
        Column(
            modifier = Modifier
                .weight(1f)
                .padding(start = 10.dp, bottom = if (isLast) 0.dp else 14.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            Text(
                step.detail ?: step.title,
                style = if (step.kind == RunStep.Kind.Prompt) {
                    MaterialTheme.typography.titleSmall
                } else {
                    MaterialTheme.typography.bodyMedium
                },
                color = if (isCurrent || step.kind != RunStep.Kind.Tool) {
                    MaterialTheme.colorScheme.onSurface
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
            // The description replaces the title in the lead line, so the
            // title moves down beside the tool name rather than being lost.
            val secondary = listOfNotNull(
                step.title.takeIf { step.detail != null },
                step.toolName,
            )
            if (secondary.isNotEmpty()) {
                Text(
                    secondary.joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium
                        .copy(fontFamily = FontFamily.Monospace),
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun ResultCard(
    title: String,
    body: String,
    accent: Color,
    onDismiss: () -> Unit,
) {
    Surface(
        shape = MaterialTheme.shapes.large,
        color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    title,
                    style = MaterialTheme.typography.titleSmall,
                    color = accent,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss, modifier = Modifier.size(28.dp)) {
                    Icon(
                        OperatorIcons.Close,
                        contentDescription = "Dismiss",
                        modifier = Modifier.size(16.dp),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Text(body, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

/**
 * Pinned bottom bar. One field and one round button that morphs: microphone
 * while the field is empty, send once there is something to send, stop while a
 * run is in flight. There is never more than one obvious next tap.
 */
@Composable
private fun Composer(
    task: TaskUiState,
    ready: Boolean,
    offerMic: Boolean,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicTap: () -> Unit,
) {
    val canSend = ready && !task.runActive && task.prompt.isNotBlank()
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(
                1.dp,
                if (task.micListening) MaterialTheme.colorScheme.primary
                else MaterialTheme.colorScheme.outline,
            ),
            modifier = Modifier.weight(1f),
        ) {
            Box(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 14.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (task.prompt.isEmpty()) {
                    Text(
                        when {
                            task.micListening -> "Listening…"
                            // Sending now adds a turn to the session that is
                            // already on screen, so say so.
                            task.runId != null -> "Say what to do next…"
                            else -> "What should the agent do?"
                        },
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                BasicTextField(
                    value = task.prompt,
                    onValueChange = onPromptChange,
                    enabled = !task.runActive,
                    textStyle = LocalTextStyle.current.merge(
                        MaterialTheme.typography.bodyLarge,
                    ).copy(
                        color = MaterialTheme.colorScheme.onSurface,
                        fontFamily = FontFamily.Default,
                    ),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    interactionSource = remember { MutableInteractionSource() },
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 132.dp),
                )
            }
        }

        ComposerAction(
            task = task,
            canSend = canSend,
            offerMic = offerMic,
            onSend = onSend,
            onStop = onStop,
            onMicTap = onMicTap,
        )
    }
}

@Composable
private fun ComposerAction(
    task: TaskUiState,
    canSend: Boolean,
    offerMic: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onMicTap: () -> Unit,
) {
    val stopping = task.runActive
    // The hero already is the microphone; a second one beside it would just
    // be two buttons doing the same thing.
    val micMode = offerMic && !stopping && task.prompt.isBlank() && task.micAvailable
    val container = when {
        stopping -> MaterialTheme.colorScheme.error
        canSend -> MaterialTheme.colorScheme.primary
        micMode && task.micListening -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.surfaceVariant
    }
    val content = when {
        stopping || canSend || (micMode && task.micListening) ->
            MaterialTheme.colorScheme.onPrimary
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Surface(
        onClick = {
            when {
                stopping -> onStop()
                canSend -> onSend()
                micMode -> onMicTap()
            }
        },
        enabled = stopping || canSend || micMode,
        shape = PillShape,
        color = container,
        modifier = Modifier.size(52.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(
                when {
                    stopping -> OperatorIcons.Stop
                    micMode -> OperatorIcons.Mic
                    else -> OperatorIcons.Send
                },
                contentDescription = when {
                    stopping -> "Stop the run"
                    micMode -> "Speak a task"
                    else -> "Send task"
                },
                modifier = Modifier.size(22.dp),
                tint = if (stopping) MaterialTheme.colorScheme.onError else content,
            )
        }
    }
}

@Composable
private fun SuggestionList(onPick: (String) -> Unit) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            "TRY",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 2.dp),
        )
        SUGGESTIONS.forEach { suggestion ->
            Surface(
                onClick = { onPick(suggestion) },
                shape = PillShape,
                color = MaterialTheme.colorScheme.surface,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
            ) {
                Text(
                    suggestion,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
    }
}

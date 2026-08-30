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
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.trueforge.operator.ui.theme.ColorSchemeReady
import dev.trueforge.operator.ui.theme.PillShape

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
) {
    val hasRunSurface = task.runActive ||
        task.log.isNotEmpty() ||
        task.output != null ||
        task.error != null

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 20.dp),
    ) {
        HomeHeader(onOpenSettings = onOpenSettings)

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

        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
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
 * Live run surface: what the agent is doing now, the trailing few steps, and
 * the final answer. Scrolls independently so the composer never moves.
 */
@Composable
private fun RunPanel(task: TaskUiState, onClearResult: () -> Unit) {
    val scroll = rememberScrollState()
    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(scroll),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (task.statusLine.isNotEmpty()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                StatusDot(
                    tint = if (task.runActive) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                    pulsing = task.runActive,
                )
                Text(task.statusLine, style = MaterialTheme.typography.titleMedium)
            }
        }

        // Newest first: the current step is the one worth reading, and the
        // older lines fade out rather than competing with it.
        task.log.asReversed().take(8).forEachIndexed { index, line ->
            Text(
                line,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(
                    alpha = 1f - (index * 0.11f),
                ),
                modifier = Modifier.padding(start = 18.dp),
            )
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
                        if (task.micListening) "Listening…" else "What should the agent do?",
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

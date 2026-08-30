package dev.trueforge.operator.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.contentColorFor
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.takeOrElse
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.trueforge.operator.ui.theme.PillShape

/**
 * Small building blocks shared by the two screens. Everything here is
 * presentation only — no state of its own beyond animation.
 */

/** A labelled status pill: coloured dot, one word, optional trailing detail. */
@Composable
fun StatusPill(
    label: String,
    tint: Color,
    modifier: Modifier = Modifier,
    container: Color = MaterialTheme.colorScheme.surface,
    pulsing: Boolean = false,
    detail: String? = null,
) {
    val animatedTint by animateColorAsState(tint, label = "pillTint")
    val animatedContainer by animateColorAsState(container, label = "pillContainer")
    val onContainer = contentColorFor(animatedContainer)
        .takeOrElse { MaterialTheme.colorScheme.onSurface }
    Row(
        modifier = modifier
            .clip(PillShape)
            .background(animatedContainer)
            .border(1.dp, MaterialTheme.colorScheme.outline, PillShape)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        StatusDot(animatedTint, pulsing)
        Text(
            label,
            style = MaterialTheme.typography.labelLarge,
            color = onContainer,
        )
        if (detail != null) {
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = onContainer.copy(alpha = 0.7f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/** 8dp dot; breathes while [pulsing] so "working" reads without a spinner. */
@Composable
fun StatusDot(tint: Color, pulsing: Boolean = false, size: Int = 8) {
    val alpha = if (pulsing) {
        val transition = rememberInfiniteTransition(label = "dot")
        transition.animateFloat(
            initialValue = 0.35f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(900, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "dotAlpha",
        ).value
    } else {
        1f
    }
    Box(
        Modifier
            .size(size.dp)
            .clip(RoundedCornerShape(percent = 50))
            .background(tint.copy(alpha = alpha)),
    )
}

/**
 * A titled group of settings rows. Cards elsewhere in Material tend to stack
 * into visual noise; here the title sits *outside* a single hairline container
 * so a screen of six settings still reads as one list.
 */
@Composable
fun Section(
    title: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            title.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 4.dp, bottom = 8.dp),
        )
        Surface(
            shape = MaterialTheme.shapes.large,
            color = MaterialTheme.colorScheme.surface,
            border = androidx.compose.foundation.BorderStroke(
                1.dp,
                MaterialTheme.colorScheme.outline,
            ),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                content = { content() },
            )
        }
    }
}

/** Label on the left, value (or a control) on the right. */
@Composable
fun SettingRow(
    label: String,
    modifier: Modifier = Modifier,
    supporting: String? = null,
    trailing: @Composable (() -> Unit)? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            if (supporting != null) {
                Text(
                    supporting,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        trailing?.invoke()
    }
}

/** Icon sized and tinted consistently wherever a glyph appears inline. */
@Composable
fun GlyphIcon(
    image: ImageVector,
    contentDescription: String?,
    modifier: Modifier = Modifier,
    tint: Color = MaterialTheme.colorScheme.onSurfaceVariant,
) {
    Icon(image, contentDescription, modifier.size(20.dp), tint = tint)
}

package dev.trueforge.operator.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathBuilder
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

/**
 * The five glyphs this app needs, drawn locally.
 *
 * material-icons-core ships no microphone and material-icons-extended would
 * add megabytes of vectors to a five-icon app, so they are declared here and
 * tinted by the caller through [androidx.compose.material3.Icon].
 */
object OperatorIcons {

    /** Capsule plus the arc-and-stem stand: the universal dictation affordance. */
    val Mic: ImageVector by lazy {
        icon("Mic") {
            path(fill = SolidColor(Color.Black)) {
                moveTo(9f, 11f)
                verticalLineTo(5.5f)
                arcTo(3f, 3f, 0f, false, true, 15f, 5.5f)
                verticalLineTo(11f)
                arcTo(3f, 3f, 0f, false, true, 9f, 11f)
                close()
            }
            stroke(width = 2f) {
                moveTo(5.5f, 11f)
                verticalLineTo(11.5f)
                arcTo(6.5f, 6.5f, 0f, false, false, 18.5f, 11.5f)
                verticalLineTo(11f)
                moveTo(12f, 18f)
                verticalLineTo(21.5f)
            }
        }
    }

    /** Two sliders — settings without the fussy detail of a gear at 20dp. */
    val Sliders: ImageVector by lazy {
        icon("Sliders") {
            stroke(width = 2f) {
                moveTo(3.5f, 8.5f)
                horizontalLineTo(12f)
                moveTo(17f, 8.5f)
                horizontalLineTo(20.5f)
                moveTo(3.5f, 15.5f)
                horizontalLineTo(7f)
                moveTo(12f, 15.5f)
                horizontalLineTo(20.5f)
            }
            path(fill = SolidColor(Color.Black)) {
                circle(cx = 14.5f, cy = 8.5f, r = 2.4f)
                circle(cx = 9.5f, cy = 15.5f, r = 2.4f)
            }
        }
    }

    val Back: ImageVector by lazy {
        icon("Back") {
            stroke(width = 2f) {
                moveTo(14.5f, 5f)
                lineTo(7.5f, 12f)
                lineTo(14.5f, 19f)
            }
        }
    }

    val Send: ImageVector by lazy {
        icon("Send") {
            stroke(width = 2f) {
                moveTo(4.5f, 12f)
                horizontalLineTo(19f)
                moveTo(12.5f, 5.5f)
                lineTo(19f, 12f)
                lineTo(12.5f, 18.5f)
            }
        }
    }

    val Stop: ImageVector by lazy {
        icon("Stop") {
            path(fill = SolidColor(Color.Black)) {
                moveTo(8f, 7f)
                horizontalLineTo(16f)
                arcTo(1f, 1f, 0f, false, true, 17f, 8f)
                verticalLineTo(16f)
                arcTo(1f, 1f, 0f, false, true, 16f, 17f)
                horizontalLineTo(8f)
                arcTo(1f, 1f, 0f, false, true, 7f, 16f)
                verticalLineTo(8f)
                arcTo(1f, 1f, 0f, false, true, 8f, 7f)
                close()
            }
        }
    }

    val Plus: ImageVector by lazy {
        icon("Plus") {
            stroke(width = 2.4f) {
                moveTo(12f, 5f)
                verticalLineTo(19f)
                moveTo(5f, 12f)
                horizontalLineTo(19f)
            }
        }
    }

    val Close: ImageVector by lazy {
        icon("Close") {
            stroke(width = 2f) {
                moveTo(6.5f, 6.5f)
                lineTo(17.5f, 17.5f)
                moveTo(17.5f, 6.5f)
                lineTo(6.5f, 17.5f)
            }
        }
    }

    private fun PathBuilder.circle(cx: Float, cy: Float, r: Float) {
        moveTo(cx - r, cy)
        arcTo(r, r, 0f, true, true, cx + r, cy)
        arcTo(r, r, 0f, true, true, cx - r, cy)
        close()
    }

    private fun ImageVector.Builder.stroke(
        width: Float,
        block: PathBuilder.() -> Unit,
    ) = path(
        stroke = SolidColor(Color.Black),
        strokeLineWidth = width,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = block,
    )

    private inline fun icon(
        name: String,
        block: ImageVector.Builder.() -> Unit,
    ): ImageVector = ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).apply(block).build()
}

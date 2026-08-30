package dev.trueforge.operator.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.core.view.WindowCompat

/**
 * One deliberate palette instead of the Compose defaults.
 *
 * The app is a single-purpose control surface that people open, speak into and
 * close, so the scheme is quiet by design: near-neutral grounds, one indigo
 * accent that only ever marks the thing you are meant to touch, and a green
 * reserved exclusively for "the agent can actually run right now".
 */
private val Indigo = Color(0xFF4F46E5)
private val IndigoSoft = Color(0xFF8B8CF7)

private val LightScheme = lightColorScheme(
    primary = Indigo,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFE7E7FD),
    onPrimaryContainer = Color(0xFF201C6B),
    secondary = Color(0xFF475069),
    onSecondary = Color.White,
    background = Color(0xFFF7F7F9),
    onBackground = Color(0xFF14161A),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF14161A),
    surfaceVariant = Color(0xFFEFF0F4),
    onSurfaceVariant = Color(0xFF5C616C),
    outline = Color(0xFFDFE1E7),
    outlineVariant = Color(0xFFECEDF1),
    error = Color(0xFFC42B2B),
    onError = Color.White,
    errorContainer = Color(0xFFFDECEC),
    onErrorContainer = Color(0xFF7A1C1C),
)

private val DarkScheme = darkColorScheme(
    primary = IndigoSoft,
    onPrimary = Color(0xFF14142E),
    primaryContainer = Color(0xFF2A2A5C),
    onPrimaryContainer = Color(0xFFDEDEFF),
    secondary = Color(0xFFA9B0C4),
    onSecondary = Color(0xFF1B1F28),
    background = Color(0xFF0B0C0F),
    onBackground = Color(0xFFE9EAEE),
    surface = Color(0xFF14161B),
    onSurface = Color(0xFFE9EAEE),
    surfaceVariant = Color(0xFF1D2027),
    onSurfaceVariant = Color(0xFF9AA0AC),
    outline = Color(0xFF272B33),
    outlineVariant = Color(0xFF1E222A),
    error = Color(0xFFF08A8A),
    onError = Color(0xFF2A0F0F),
    errorContainer = Color(0xFF3A1D1D),
    onErrorContainer = Color(0xFFFFD9D9),
)

/** Live/ready green. Not part of the M3 roles, so it is carried separately. */
val ReadyGreenLight = Color(0xFF15803D)
val ReadyGreenDark = Color(0xFF4ADE80)

val ColorSchemeReady: Color
    @Composable get() = if (isSystemInDarkTheme()) ReadyGreenDark else ReadyGreenLight

private val AppShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp),
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(22.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

/** Pill used by the primary actions and status chips. */
val PillShape: Shape = RoundedCornerShape(percent = 50)

private val AppTypography = Typography(
    displaySmall = TextStyle(
        fontSize = 32.sp,
        lineHeight = 38.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.6).sp,
    ),
    headlineMedium = TextStyle(
        fontSize = 26.sp,
        lineHeight = 32.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.4).sp,
    ),
    headlineSmall = TextStyle(
        fontSize = 21.sp,
        lineHeight = 27.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.3).sp,
    ),
    titleMedium = TextStyle(
        fontSize = 16.sp,
        lineHeight = 22.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = (-0.1).sp,
    ),
    titleSmall = TextStyle(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.SemiBold,
    ),
    bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 25.sp),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = TextStyle(
        fontSize = 15.sp,
        lineHeight = 20.sp,
        fontWeight = FontWeight.SemiBold,
        letterSpacing = 0.1.sp,
    ),
    labelMedium = TextStyle(
        fontSize = 12.sp,
        lineHeight = 16.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.4.sp,
    ),
    labelSmall = TextStyle(
        fontSize = 11.sp,
        lineHeight = 15.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = 0.8.sp,
    ),
)

@Composable
fun TrueForgeTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val scheme = if (darkTheme) DarkScheme else LightScheme
    val view = LocalView.current
    if (!view.isInEditMode) {
        // The activity draws edge to edge; only the system-bar icon contrast
        // needs to follow the theme (bar colors are ignored from SDK 35 on).
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    MaterialTheme(
        colorScheme = scheme,
        typography = AppTypography,
        shapes = AppShapes,
        content = content,
    )
}

package dev.trueforge.operator.accessibility

/**
 * Tries the snapshot node first, then retries against Android's real input
 * focus after the target has been focused. Kept Android-free so the ordering
 * and fail-closed behavior can be covered by local unit tests.
 */
internal suspend fun <Node> setTextWithFocusedFallback(
    target: Node,
    value: String,
    setText: (Node, String) -> Boolean,
    focus: (Node) -> Unit,
    awaitFocused: suspend () -> Node?,
): Boolean {
    if (setText(target, value)) return true
    focus(target)
    val focused = awaitFocused() ?: return false
    return setText(focused, value)
}

package dev.trueforge.operator.ui

import dev.trueforge.operator.networking.TaskRunClient.RunEvent

/**
 * One line in the run timeline.
 *
 * Raw tool names are what the wire carries and what the dashboard shows, but
 * they are the wrong unit for a phone: nobody watching their own device wants
 * to read `execute_and_observe`. Each step therefore leads with what happened
 * ("Tapped an element"), keeps the tool name beside it for anyone who does
 * care, and drops to a plain title when the arguments never said enough.
 */
data class RunStep(
    val key: String,
    val kind: Kind,
    val title: String,
    val toolName: String? = null,
    val detail: String? = null,
) {
    enum class Kind { Tool, Approval, Question, Failure }
}

/**
 * Human titles for the bridge's tools. Anything unmapped falls back to its own
 * name, so a tool added to the bridge shows up as itself rather than vanishing.
 */
private val TOOL_TITLES = mapOf(
    "get_screen" to "Read the screen",
    "find_nodes" to "Searched the screen",
    "execute_action" to "Acted on the screen",
    "execute_and_observe" to "Acted, then looked again",
    "commit_action" to "Asked to go ahead",
    "wait_for" to "Waited for the screen",
    "capture_screenshot" to "Took a screenshot",
    "inspect_screen_visually" to "Looked at the screen",
    "get_device_state" to "Checked the device",
    "get_media_state" to "Checked playback",
    "get_notifications" to "Read notifications",
    "get_operator_capabilities" to "Checked what it can do",
)

fun toolTitle(name: String): String = TOOL_TITLES[name] ?: name

/**
 * Folds one run envelope into the UI state.
 *
 * Pure so the whole run presentation can be tested without a device: the
 * activity keeps the coroutine, the cancellation and the recognizer, and hands
 * every envelope through here.
 */
fun TaskUiState.applying(event: RunEvent): TaskUiState {
    var steps = this.steps

    if (event.tools.isNotEmpty()) {
        steps = steps + event.tools.map {
            RunStep(
                key = it.key,
                kind = RunStep.Kind.Tool,
                title = toolTitle(it.name),
                toolName = it.name,
            )
        }
    }

    if (event.toolDetails.isNotEmpty()) {
        val byKey = event.toolDetails.associate { it.key to it.detail }
        steps = steps.map { step ->
            byKey[step.key]?.let { step.copy(detail = it) } ?: step
        }
    }

    steps = when (event.type) {
        "approval.pending" -> steps + RunStep(
            key = "approval-${steps.size}",
            kind = RunStep.Kind.Approval,
            title = "Waiting for you to approve",
        )
        "approval.decided" -> steps + RunStep(
            key = "decision-${steps.size}",
            kind = RunStep.Kind.Approval,
            title = event.summary ?: "Approval decided",
        )
        "question.pending" -> steps + RunStep(
            key = "question-${steps.size}",
            kind = RunStep.Kind.Question,
            title = "Waiting for your answer",
        )
        "question.answered" -> steps + RunStep(
            key = "answer-${steps.size}",
            kind = RunStep.Kind.Question,
            title = "Answer submitted",
        )
        "run.failed" -> steps + RunStep(
            key = "failed-${steps.size}",
            kind = RunStep.Kind.Failure,
            title = event.error ?: "Run failed",
        )
        else -> steps
    }

    val statusLine = when (event.type) {
        "run.created" -> "Starting…"
        "run.started" -> "Working"
        "agent.event" -> event.tools.lastOrNull()?.let { toolTitle(it.name) } ?: statusLine
        "approval.pending" -> "Needs your approval"
        "question.pending" -> "Needs your answer"
        "approval.decided", "question.answered" -> "Working"
        "run.completed" -> "Done"
        "run.failed" -> "Failed"
        else -> statusLine
    }

    return copy(
        runId = event.runId ?: runId,
        statusLine = statusLine,
        // The tail is what anyone actually reads, and an unbounded list on a
        // long run is just memory the phone does not have to spend.
        steps = steps.takeLast(MAX_STEPS),
        output = event.output ?: output,
        error = event.error ?: error,
        runActive = if (event.isTerminal) false else runActive,
    )
}

private const val MAX_STEPS = 40

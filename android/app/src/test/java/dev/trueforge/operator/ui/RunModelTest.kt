package dev.trueforge.operator.ui

import dev.trueforge.operator.networking.TaskRunClient.RunEvent
import dev.trueforge.operator.networking.TaskRunClient.ToolCall
import dev.trueforge.operator.networking.TaskRunClient.ToolDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RunModelTest {

    private fun toolEvent(vararg calls: Pair<String, String>) = RunEvent(
        type = "agent.event",
        tools = calls.map { ToolCall(it.first, it.second) },
    )

    @Test
    fun `tool calls become titled steps`() {
        val state = TaskUiState().applying(toolEvent("m1#0" to "get_screen"))

        assertEquals(1, state.steps.size)
        assertEquals("Read the screen", state.steps.single().title)
        assertEquals("get_screen", state.steps.single().toolName)
        assertNull(state.steps.single().detail)
        assertEquals("Read the screen", state.statusLine)
    }

    @Test
    fun `an unmapped tool keeps its own name as the title`() {
        val state = TaskUiState().applying(toolEvent("m1#0" to "brand_new_tool"))

        assertEquals("brand_new_tool", state.steps.single().title)
    }

    @Test
    fun `a detail attaches to the step it belongs to`() {
        val state = TaskUiState()
            .applying(toolEvent("m1#0" to "get_screen", "m1#1" to "execute_action"))
            .applying(
                RunEvent(
                    type = "agent.event",
                    toolDetails = listOf(ToolDetail("m1#1", "Typed hi")),
                ),
            )

        assertNull(state.steps[0].detail)
        assertEquals("Typed hi", state.steps[1].detail)
    }

    @Test
    fun `approvals and answers appear on the timeline`() {
        val state = TaskUiState()
            .applying(RunEvent(type = "approval.pending", summary = "Waiting"))
            .applying(RunEvent(type = "approval.decided", summary = "Approval allowed"))

        assertEquals(
            listOf("Waiting for you to approve", "Approval allowed"),
            state.steps.map { it.title },
        )
        assertTrue(state.steps.all { it.kind == RunStep.Kind.Approval })
        assertEquals("Working", state.statusLine)
    }

    @Test
    fun `a pending approval names itself in the status line`() {
        assertEquals(
            "Needs your approval",
            TaskUiState().applying(RunEvent(type = "approval.pending")).statusLine,
        )
    }

    @Test
    fun `only the tail of a long run is kept`() {
        var state = TaskUiState()
        repeat(60) { state = state.applying(toolEvent("m$it#0" to "get_screen")) }

        assertEquals(40, state.steps.size)
        assertEquals("m59#0", state.steps.last().key)
    }

    @Test
    fun `a terminal event releases the run and keeps its output`() {
        val state = TaskUiState(runActive = true)
            .applying(RunEvent(type = "run.completed", output = "Sent.", runId = "r1"))

        assertFalse(state.runActive)
        assertEquals("Sent.", state.output)
        assertEquals("Done", state.statusLine)
        assertEquals("r1", state.runId)
    }

    @Test
    fun `a failure is both a step and an error`() {
        val state = TaskUiState(runActive = true)
            .applying(RunEvent(type = "run.failed", error = "cancelled by user"))

        assertFalse(state.runActive)
        assertEquals("cancelled by user", state.error)
        assertEquals(RunStep.Kind.Failure, state.steps.single().kind)
    }

    @Test
    fun `an event with nothing to say leaves the status line alone`() {
        val state = TaskUiState(statusLine = "Working")
            .applying(RunEvent(type = "something.new"))

        assertEquals("Working", state.statusLine)
        assertTrue(state.steps.isEmpty())
    }
}

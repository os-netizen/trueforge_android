package dev.trueforge.operator.networking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The descriptions are read out of a *streaming* argument buffer, so every
 * case here is written the way the buffer actually looks: a fragment of JSON
 * that may never be closed.
 */
class ToolDescriptionTest {

    private fun describe(tool: String, buffer: String, final: Boolean = true) =
        TaskRunClient.describeCall(tool, buffer, final)

    @Test
    fun `typed text is quoted back`() {
        assertEquals(
            "Typed “hi”",
            describe("execute_action", """{"action":{"type":"set_text","nodeId":"n4","text":"hi"}"""),
        )
    }

    @Test
    fun `a launch names the package`() {
        assertEquals(
            "Opened com.whatsapp",
            describe("execute_action", """{"action":{"type":"launch_app","packageName":"com.whatsapp"}}"""),
        )
    }

    @Test
    fun `a global action reads as a key press`() {
        assertEquals(
            "Pressed quick settings",
            describe("execute_action", """{"action":{"type":"global_action","action":"quick_settings"}}"""),
        )
    }

    @Test
    fun `a coordinate tap reports both axes`() {
        assertEquals(
            "Tapped (540, 1200)",
            describe("execute_action", """{"action":{"type":"tap_coordinates","x":540,"y":1200}}"""),
        )
    }

    @Test
    fun `a gated call prefers the model's own intent`() {
        assertEquals(
            "Send the message to Baba",
            describe(
                "commit_action",
                """{"intent":"Send the message to Baba","action":{"type":"click_node","nodeId":"n9"}}""",
            ),
        )
    }

    @Test
    fun `a search reports its query`() {
        assertEquals(
            "Looked for “Enter Drop”",
            describe("find_nodes", """{"query":"Enter Drop","limit":10}"""),
        )
    }

    @Test
    fun `a vague description waits for the argument that would sharpen it`() {
        val partial = """{"action":{"type":"click_node","snapshotId":"snap_3""""
        assertNull(describe("execute_action", partial, final = false))
        assertEquals("Tapped an element", describe("execute_action", partial, final = true))
    }

    @Test
    fun `a tool with nothing to describe stays silent`() {
        assertNull(describe("get_screen", """{"deviceTarget":"Y3BoMjQ5MS1mZmQ3"}"""))
    }

    @Test
    fun `details are emitted once, after the call is reported`() {
        val reader = TaskRunClient.EnvelopeReader()
        // Escaped exactly as TrueForge sends argument fragments: a JSON string
        // whose contents are themselves JSON.
        fun fragment(escaped: String) =
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":""" +
                """{"arguments":"$escaped"}}],"type":"model.message.delta","id":"m1"}}"""

        val named = """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":""" +
            """{"name":"execute_action","arguments":""}}],"type":"model.message.delta","id":"m1"}}"""

        val first = reader.read(named)!!
        assertEquals(listOf("execute_action"), first.tools.map { it.name })
        assertEquals(emptyList<TaskRunClient.ToolDetail>(), first.toolDetails)

        val second = reader.read(fragment("""{\"action\": {\"type\": \"launch_app\","""))!!
        assertEquals(emptyList<TaskRunClient.ToolCall>(), second.tools)
        assertEquals(emptyList<TaskRunClient.ToolDetail>(), second.toolDetails)

        val third = reader.read(fragment("""\"packageName\": \"com.whatsapp\"}}"""))!!
        assertEquals(
            listOf(TaskRunClient.ToolDetail("m1#0", "Opened com.whatsapp")),
            third.toolDetails,
        )

        // Reported once: a later fragment must not repeat it.
        assertEquals(emptyList<TaskRunClient.ToolDetail>(), reader.read(fragment(" "))!!.toolDetails)
    }
}

/**
 * The one wire-visible half of "typing in the same box continues the session":
 * the server opens a new session when `runId` is absent and adds a turn when
 * it is present, so its presence is the whole contract.
 */
class RunRequestBodyTest {

    @Test
    fun `a fresh task sends no run id`() {
        assertEquals(
            """{"prompt":"open WhatsApp","deviceId":"cph2491-ffd7"}""",
            TaskRunClient.requestBody("open WhatsApp", "cph2491-ffd7", null),
        )
    }

    @Test
    fun `a continued task carries the run it belongs to`() {
        assertEquals(
            """{"prompt":"now send another","deviceId":"cph2491-ffd7","runId":"01m197dj4n5h"}""",
            TaskRunClient.requestBody("now send another", "cph2491-ffd7", "01m197dj4n5h"),
        )
    }
}

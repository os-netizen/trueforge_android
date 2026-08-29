package dev.trueforge.operator.networking

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-function coverage for the phone's run client: URL derivation and the
 * NDJSON envelope parsing that the whole task card depends on. Fixture lines
 * mirror what the server actually writes in `dashboard/runs.ts`.
 */
class TaskRunClientTest {

    private val reader = TaskRunClient.EnvelopeReader()

    @Test
    fun `derives http base from device websocket url`() {
        assertEquals(
            "http://100.116.152.115:8792",
            TaskRunClient.baseHttpUrl("ws://100.116.152.115:8792/device"),
        )
    }

    @Test
    fun `wss maps to https`() {
        assertEquals("https://host.example:8792", TaskRunClient.baseHttpUrl("wss://host.example:8792/device"))
    }

    @Test
    fun `strips path query and fragment and tolerates whitespace`() {
        assertEquals(
            "http://127.0.0.1:8792",
            TaskRunClient.baseHttpUrl("  ws://127.0.0.1:8792/device?token=x#frag  "),
        )
    }

    @Test
    fun `accepts an http url unchanged`() {
        assertEquals("http://127.0.0.1:8792", TaskRunClient.baseHttpUrl("http://127.0.0.1:8792"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun `rejects garbage`() {
        TaskRunClient.baseHttpUrl("not a url")
    }

    @Test(expected = IllegalArgumentException::class)
    fun `rejects empty input`() {
        TaskRunClient.baseHttpUrl("   ")
    }

    @Test
    fun `parses run created`() {
        val event = reader.read(
            """{"type":"run.created","data":{"id":"r1","prompt":"hi","status":"starting","eventCount":0}}""",
        )!!
        assertEquals("run.created", event.type)
        assertEquals("r1", event.runId)
        assertEquals("starting", event.status)
        assertEquals("Starting…", event.summary)
        assertTrue(!event.isTerminal)
    }

    @Test
    fun `names a plain tool the moment its name delta arrives`() {
        val event = reader.read(
            """{"type":"agent.event","data":{"toolCalls":[{"toolInfo":{"type":"truefoundry-system",""" +
                """"name":"list_tools"},"index":0,"id":"call_a","type":"function","function":""" +
                """{"name":"list_tools","arguments":""}}],"type":"model.message.delta","id":"m1"}}""",
        )!!
        assertEquals("list_tools", event.summary)
    }

    @Test
    fun `unwraps code mode call_tool once argument fragments accumulate`() {
        // Captured verbatim from a real run: the name arrives with empty
        // arguments, and tool_name only becomes readable several deltas later.
        val lines = listOf(
            """{"type":"agent.event","data":{"toolCalls":[{"toolInfo":{"type":"truefoundry-system","name":"call_tool"},""" +
                """"index":0,"id":"call_b","type":"function","function":{"name":"call_tool","arguments":""}}],""" +
                """"type":"model.message.delta","id":"m2"}}""",
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"arguments":"{"}}],""" +
                """"type":"model.message.delta","id":"m2"}}""",
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"arguments":"\"mcp_server\": \"android-"}}],""" +
                """"type":"model.message.delta","id":"m2"}}""",
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"arguments":"tool-bridge\""}}],""" +
                """"type":"model.message.delta","id":"m2"}}""",
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"arguments":", \"tool_name\": \"get_device_state\""}}],""" +
                """"type":"model.message.delta","id":"m2"}}""",
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"arguments":", \"input\": {}}"}}],""" +
                """"type":"model.message.delta","id":"m2"}}""",
        )
        val summaries = lines.mapNotNull { reader.read(it)?.summary }
        assertEquals(listOf("get_device_state"), summaries)
    }

    @Test
    fun `reports each tool exactly once across its deltas`() {
        val first = """{"type":"agent.event","data":{"toolCalls":[{"index":0,"id":"call_c","function":""" +
            """{"name":"get_tool_info","arguments":""}}],"type":"model.message.delta","id":"m3"}}"""
        val fragment = """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"arguments":"{}"}}],""" +
            """"type":"model.message.delta","id":"m3"}}"""
        assertEquals("get_tool_info", reader.read(first)!!.summary)
        assertNull(reader.read(fragment)!!.summary)
        assertNull(reader.read(fragment)!!.summary)
    }

    @Test
    fun `tool calls under different message ids do not collide on index`() {
        val line = { id: String, name: String ->
            """{"type":"agent.event","data":{"toolCalls":[{"index":0,"function":{"name":"$name","arguments":""}}],""" +
                """"type":"model.message.delta","id":"$id"}}"""
        }
        assertEquals("observe_screen", reader.read(line("m4", "observe_screen"))!!.summary)
        assertEquals("commit_action", reader.read(line("m5", "commit_action"))!!.summary)
    }

    @Test
    fun `agent events without tool calls have no summary`() {
        val event = reader.read(
            """{"type":"agent.event","data":{"type":"tool.response","id":"e9","content":"{}"}}""",
        )!!
        assertNull(event.summary)
    }

    @Test
    fun `approval pending reads as a wait`() {
        val event = reader.read(
            """{"type":"approval.pending","data":{"runId":"r1","toolCallId":"c3","intent":"Dismiss a notification"}}""",
        )!!
        assertEquals("r1", event.runId)
        assertEquals("Waiting for your approval…", event.summary)
    }

    @Test
    fun `approval decided reports the decision`() {
        val allowed = reader.read(
            """{"type":"approval.decided","data":{"runId":"r1","toolCallId":"c3","decision":"allow","reason":null}}""",
        )!!
        val denied = reader.read(
            """{"type":"approval.decided","data":{"runId":"r1","toolCallId":"c4","decision":"deny","reason":"timeout"}}""",
        )!!
        assertEquals("Approval allowed", allowed.summary)
        assertEquals("Approval denied", denied.summary)
    }

    @Test
    fun `parses run completed output`() {
        val event = reader.read(
            """{"type":"run.completed","data":{"id":"r1","status":"completed","output":"Home screen is showing.","eventCount":12}}""",
        )!!
        assertEquals("Home screen is showing.", event.output)
        assertTrue(event.isTerminal)
    }

    @Test
    fun `parses run failed error`() {
        val event = reader.read(
            """{"type":"run.failed","data":{"id":"r1","status":"failed","error":"cancelled by user"}}""",
        )!!
        assertEquals("cancelled by user", event.error)
        assertEquals("Run failed: cancelled by user", event.summary)
        assertTrue(event.isTerminal)
    }

    @Test
    fun `skips blank partial and malformed lines without throwing`() {
        assertNull(reader.read(""))
        assertNull(reader.read("   "))
        assertNull(reader.read("""{"type":"run.created","data":{"id":"r1"""))
        assertNull(reader.read("not json at all"))
        assertNull(reader.read("""{"data":{"id":"r1"}}"""))
    }

    @Test
    fun `unknown envelope types survive as pass-through`() {
        val event = reader.read("""{"type":"something.new","data":{}}""")!!
        assertEquals("something.new", event.type)
        assertNull(event.summary)
    }
}

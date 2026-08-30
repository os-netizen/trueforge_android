package dev.trueforge.operator.networking

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import kotlinx.coroutines.job
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Phone-side consumer of the server's run pipeline (brief 03).
 *
 * The phone starts tasks through exactly the same endpoint the dashboard uses
 * — `POST /api/dashboard/runs`, an NDJSON stream of `{ type, data }` envelopes
 * — so there is one run path, not a separate "voice" one. Parsing mirrors the
 * dashboard consumer: split on newlines, JSON-parse non-empty lines, tolerate
 * a trailing partial line and skip anything unparseable.
 */
class TaskRunClient(
    private val serverUrlProvider: () -> String,
    private val deviceIdProvider: () -> String,
) {

    /**
     * Minimal projection of an NDJSON envelope. Payload shapes vary across
     * event types (and TrueForge streams partial deltas), so everything is
     * read leniently out of a [JsonObject] rather than a strict data class.
     */
    data class RunEvent(
        val type: String,
        val runId: String? = null,
        val status: String? = null,
        val output: String? = null,
        val error: String? = null,
        val summary: String? = null,
        val tools: List<ToolCall> = emptyList(),
        val toolDetails: List<ToolDetail> = emptyList(),
    ) {
        val isTerminal: Boolean get() = type == "run.completed" || type == "run.failed"
    }

    /**
     * One tool the model invoked. [key] is stable for the life of the run, so
     * the detail that arrives a few fragments later can find its own call.
     */
    data class ToolCall(val key: String, val name: String)

    /**
     * What that call actually did — "Typed \"hi\"", "Opened com.whatsapp" —
     * recovered from the arguments once enough of them have streamed in.
     */
    data class ToolDetail(val key: String, val detail: String)

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

        private val json = Json {
            ignoreUnknownKeys = true
            isLenient = true
        }

        /**
         * `ws://host:port/device` -> `http://host:port` (and `wss` -> `https`).
         * Any path, query or fragment is dropped; the run API lives at the
         * root of the same origin as the device WebSocket.
         */
        fun baseHttpUrl(serverUrl: String): String {
            val trimmed = serverUrl.trim()
            require(trimmed.isNotEmpty()) { "server url is empty" }
            val match = Regex("^(wss?|https?)://([^/?#\\s]+)", RegexOption.IGNORE_CASE)
                .find(trimmed) ?: throw IllegalArgumentException("not a ws/http url: $serverUrl")
            val scheme = when (match.groupValues[1].lowercase()) {
                "ws", "http" -> "http"
                else -> "https"
            }
            val authority = match.groupValues[2]
            require(authority.isNotEmpty()) { "server url has no host: $serverUrl" }
            return "$scheme://$authority"
        }

        private fun JsonObject.string(key: String): String? =
            (this[key] as? JsonPrimitive)?.contentOrNull

        private fun JsonObject.int(key: String): Int? =
            (this[key] as? JsonPrimitive)?.contentOrNull?.toIntOrNull()

        /** Pulls `tool_name` out of a possibly-truncated argument buffer. */
        private val TOOL_NAME = Regex("\"tool_name\"\\s*:\\s*\"([^\"]+)\"")

        private fun field(name: String) =
            Regex("\"" + name + "\"\\s*:\\s*\"([^\"]{0,120})\"")

        private val ACTION_TYPE = field("type")
        private val ENUM_ACTION = field("action")
        private val TEXT = field("text")
        private val PACKAGE_NAME = field("packageName")
        private val NODE_ID = field("nodeId")
        private val QUERY = field("query")
        private val DIRECTION = field("direction")
        private val INTENT = field("intent")
        private val COORDINATE = Regex("\"(x|y)\"\\s*:\\s*(\\d{1,5})")

        /**
         * A one-line, human description of a call, read out of its (possibly
         * still partial) argument buffer. Null until the buffer says something
         * worth showing — the caller keeps feeding it until then.
         *
         * This is a *label*, not a parse: it is only ever displayed, so a
         * regex over the fragment stream beats waiting for valid JSON that a
         * cancelled run may never finish sending.
         *
         * [final] decides what happens when the *kind* of action is known but
         * its interesting argument has not streamed in yet. Mid-stream that is
         * simply "not yet" — settling for "Opened an app" while the package
         * name is one fragment away would freeze the vaguer answer forever.
         * Once nothing more is coming, the vague answer beats no answer.
         */
        internal fun describeCall(
            toolName: String,
            buffer: CharSequence,
            final: Boolean = false,
        ): String? {
            fun orLater(vague: String) = if (final) vague else null

            // The gated tool carries the model's own sentence about what it is
            // about to do, which beats anything reconstructed from arguments.
            INTENT.find(buffer)?.groupValues?.get(1)?.let { return it }

            val text = TEXT.find(buffer)?.groupValues?.get(1)
            val pkg = PACKAGE_NAME.find(buffer)?.groupValues?.get(1)
            when (ACTION_TYPE.find(buffer)?.groupValues?.get(1)) {
                "click_node" -> return NODE_ID.find(buffer)?.groupValues?.get(1)
                    ?.let { "Tapped $it" } ?: orLater("Tapped an element")
                "long_click_node" -> return "Long-pressed an element"
                "set_text" -> return text?.let { "Typed \u201C$it\u201D" } ?: orLater("Entered text")
                "scroll" -> return DIRECTION.find(buffer)?.groupValues?.get(1)
                    ?.let { "Scrolled $it" } ?: orLater("Scrolled")
                "tap_coordinates" -> {
                    val coordinates = COORDINATE.findAll(buffer)
                        .associate { it.groupValues[1] to it.groupValues[2] }
                    val x = coordinates["x"]
                    val y = coordinates["y"]
                    return if (x != null && y != null) "Tapped ($x, $y)" else orLater("Tapped a point")
                }
                "swipe" -> return "Swiped"
                "global_action" -> return ENUM_ACTION.find(buffer)?.groupValues?.get(1)
                    ?.let { "Pressed ${it.replace('_', ' ')}" } ?: orLater("System gesture")
                "launch_app" -> return pkg?.let { "Opened $it" } ?: orLater("Opened an app")
                "media_control" -> return ENUM_ACTION.find(buffer)?.groupValues?.get(1)
                    ?.replaceFirstChar(Char::uppercase)?.let { "$it playback" }
                    ?: orLater("Controlled playback")
                "notification_action" -> return ENUM_ACTION.find(buffer)?.groupValues?.get(1)
                    ?.let { "${it.replaceFirstChar(Char::uppercase)} a notification" }
                    ?: orLater("Acted on a notification")
            }

            return when (toolName) {
                "find_nodes" -> QUERY.find(buffer)?.groupValues?.get(1)?.let { "Looked for \u201C$it\u201D" }
                "wait_for" -> pkg?.let { "Until $it" } ?: text?.let { "Until \u201C$it\u201D" }
                else -> null
            }
        }
    }

    /**
     * Stateful NDJSON reader — one per run.
     *
     * Tool names cannot be read from a single line. TrueForge streams a
     * `model.message` as deltas: the first carries `function.name` with empty
     * arguments, and later ones carry argument *fragments* keyed only by
     * `index` under the same message id. Code Mode wraps every real tool in
     * `call_tool`, so the interesting name (`tool_name`) only becomes readable
     * once enough fragments have accumulated. This reader joins them per
     * (message id, index) and reports each tool exactly once.
     */
    class EnvelopeReader {

        private val names = mutableMapOf<String, String>()
        private val arguments = mutableMapOf<String, StringBuilder>()
        private val reported = mutableSetOf<String>()
        private val described = mutableSetOf<String>()
        private var newestCall: String? = null

        /** Parses one NDJSON line. Returns null for blank or malformed lines. */
        fun read(line: String): RunEvent? {
            if (line.isBlank()) return null
            val root = try {
                json.parseToJsonElement(line) as? JsonObject
            } catch (_: Throwable) {
                null
            } ?: return null
            val type = root.string("type") ?: return null
            val data = root["data"] as? JsonObject ?: JsonObject(emptyMap())
            val event = when (type) {
                "run.created", "run.started", "run.completed", "run.failed" -> RunEvent(
                    type = type,
                    runId = data.string("id"),
                    status = data.string("status"),
                    output = data.string("output"),
                    error = data.string("error"),
                    summary = when (type) {
                        "run.created" -> "Starting…"
                        "run.started" -> "Agent working"
                        "run.completed" -> "Run complete"
                        else -> data.string("error")?.let { "Run failed: $it" } ?: "Run failed"
                    },
                )
                "agent.event" -> {
                    val tools = agentTools(data)
                    RunEvent(
                        type = type,
                        // Preserved verbatim: the joined names are what the
                        // status line has always shown.
                        summary = tools.takeIf { it.isNotEmpty() }
                            ?.joinToString(", ") { it.name },
                        tools = tools,
                        toolDetails = drainDetails(),
                    )
                }
                "approval.pending" -> RunEvent(
                    type = type,
                    runId = data.string("runId"),
                    summary = "Waiting for your approval…",
                )
                "approval.decided" -> RunEvent(
                    type = type,
                    runId = data.string("runId"),
                    summary = when (data.string("decision")) {
                        "allow" -> "Approval allowed"
                        else -> "Approval denied"
                    },
                )
                "question.pending" -> RunEvent(
                    type = type,
                    runId = data.string("runId"),
                    summary = "Waiting for your answer…",
                )
                "question.answered" -> RunEvent(
                    type = type,
                    runId = data.string("runId"),
                    summary = "Answer submitted",
                )
                else -> RunEvent(type = type)
            }
            // Anything that is not a model delta means the turn has moved on:
            // flush whatever the open buffers can still describe.
            return if (type == "agent.event") event else {
                event.copy(toolDetails = event.toolDetails + drainDetails(force = true))
            }
        }

        /**
         * Tools newly identified by this event. Most deltas are argument
         * fragments and identify nothing, and each call is reported exactly
         * once — on the line that first names it.
         */
        private fun agentTools(data: JsonObject): List<ToolCall> {
            val calls = data["toolCalls"] as? JsonArray ?: return emptyList()
            val messageId = data.string("id") ?: ""
            return calls.mapNotNull { element ->
                val call = element as? JsonObject ?: return@mapNotNull null
                val key = "$messageId#${call.int("index") ?: 0}"
                val function = call["function"] as? JsonObject ?: return@mapNotNull null

                function.string("name")?.takeIf { it.isNotBlank() }?.let { names[key] = it }

                // Fragments keep accumulating after the call is reported: the
                // arguments are what the description is read out of, and they
                // arrive well after the name does.
                if (key in arguments || key !in reported) {
                    val buffer = arguments.getOrPut(key) { StringBuilder() }
                    function.string("arguments")?.let {
                        if (buffer.length < MAX_ARGUMENT_CHARS) buffer.append(it)
                    }
                }

                val name = names[key] ?: return@mapNotNull null
                if (key in reported) return@mapNotNull null

                // A plain tool is identified the moment its name arrives.
                if (name != CALL_TOOL) {
                    reported += key
                    newestCall = key
                    return@mapNotNull ToolCall(key, name)
                }

                // Code Mode's wrapper: keep joining fragments until tool_name
                // is readable. The cap keeps a large argument blob (a full
                // action payload) from growing without bound on the phone.
                val unwrapped = TOOL_NAME.find(arguments[key] ?: return@mapNotNull null)
                    ?.groupValues?.get(1)
                    ?: return@mapNotNull null
                reported += key
                newestCall = key
                names[key] = unwrapped
                ToolCall(key, unwrapped)
            }
        }

        /**
         * Descriptions that have become readable since the last event, each
         * emitted once. A buffer is dropped as soon as it has said what it can
         * — or once it hits the cap and never will.
         */
        private fun drainDetails(force: Boolean = false): List<ToolDetail> {
            if (arguments.isEmpty()) return emptyList()
            val details = mutableListOf<ToolDetail>()
            val finished = mutableListOf<String>()
            for ((key, buffer) in arguments) {
                if (key !in reported) continue
                val name = names[key] ?: continue
                // Only the newest call can still be growing; anything behind
                // it has said everything it is going to say.
                val detail = describeCall(name, buffer, final = force || key != newestCall)
                if (detail != null && described.add(key)) {
                    details += ToolDetail(key, detail)
                    finished += key
                } else if (buffer.length >= MAX_ARGUMENT_CHARS) {
                    finished += key
                }
            }
            finished.forEach(arguments::remove)
            // A tool with nothing to describe (get_screen and friends) would
            // otherwise hold its buffer for the whole run. Insertion order is
            // age order, so the oldest stragglers go first.
            while (arguments.size > MAX_LIVE_BUFFERS) {
                arguments.remove(arguments.keys.first())
            }
            return details
        }

        private companion object {
            const val CALL_TOOL = "call_tool"
            const val MAX_ARGUMENT_CHARS = 4096
            const val MAX_LIVE_BUFFERS = 8
        }
    }

    /**
     * A run streams for minutes and pauses for approvals, so this client has
     * no read timeout of its own; cancelling the collecting coroutine (or the
     * Stop button, via [cancel]) is what ends it.
     */
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.SECONDS)
        .callTimeout(0, TimeUnit.SECONDS)
        .build()

    fun start(prompt: String): Flow<RunEvent> = flow {
        // One reader per run: tool-call fragments are only meaningful within
        // the run that produced them.
        val reader = EnvelopeReader()
        val base = baseHttpUrl(serverUrlProvider())
        val body = json.encodeToString(
            JsonObject.serializer(),
            JsonObject(mapOf(
                "prompt" to JsonPrimitive(prompt),
                "deviceId" to JsonPrimitive(deviceIdProvider()),
            )),
        ).toRequestBody(JSON_MEDIA_TYPE)
        val request = Request.Builder()
            .url("$base/api/dashboard/runs")
            .post(body)
            .build()

        val call = client.newCall(request)
        val cancellation = currentCoroutineContext().job.invokeOnCompletion { call.cancel() }
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) {
                    val detail = response.body.string().take(300)
                    emit(
                        RunEvent(
                            type = "run.failed",
                            status = "failed",
                            error = "HTTP ${response.code}${if (detail.isBlank()) "" else ": $detail"}",
                            summary = "Run failed",
                        ),
                    )
                    return@use
                }
                val source = response.body.source()
                while (true) {
                    val line = source.readUtf8Line() ?: break
                    val event = reader.read(line) ?: continue
                    emit(event)
                }
            }
        } finally {
            cancellation.dispose()
        }
    }.flowOn(Dispatchers.IO)

    suspend fun cancel(runId: String) {
        val base = baseHttpUrl(serverUrlProvider())
        val request = Request.Builder()
            .url("$base/api/dashboard/runs/${runId}/cancel")
            .post("".toRequestBody(JSON_MEDIA_TYPE))
            .build()
        withContext(Dispatchers.IO) {
            client.newCall(request).execute().close()
        }
    }
}

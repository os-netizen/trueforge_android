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
class TaskRunClient(private val serverUrlProvider: () -> String) {

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
    ) {
        val isTerminal: Boolean get() = type == "run.completed" || type == "run.failed"
    }

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
            return when (type) {
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
                "agent.event" -> RunEvent(type = type, summary = agentEventSummary(data))
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
        }

        /**
         * Names of tools newly identified by this event, or null when the
         * event adds nothing (most deltas are argument fragments, and every
         * tool is reported only on the line that first identifies it).
         */
        private fun agentEventSummary(data: JsonObject): String? {
            val calls = data["toolCalls"] as? JsonArray ?: return null
            val messageId = data.string("id") ?: ""
            val fresh = calls.mapNotNull { element ->
                val call = element as? JsonObject ?: return@mapNotNull null
                val key = "$messageId#${call.int("index") ?: 0}"
                if (key in reported) return@mapNotNull null
                val function = call["function"] as? JsonObject ?: return@mapNotNull null

                function.string("name")?.takeIf { it.isNotBlank() }?.let { names[key] = it }
                val name = names[key] ?: return@mapNotNull null

                // A plain tool is identified the moment its name arrives.
                if (name != CALL_TOOL) {
                    reported += key
                    arguments.remove(key)
                    return@mapNotNull name
                }

                // Code Mode's wrapper: keep joining fragments until tool_name
                // is readable. The cap keeps a large argument blob (a full
                // action payload) from growing without bound on the phone.
                val buffer = arguments.getOrPut(key) { StringBuilder() }
                function.string("arguments")?.let {
                    if (buffer.length < MAX_ARGUMENT_CHARS) buffer.append(it)
                }
                val unwrapped = TOOL_NAME.find(buffer)?.groupValues?.get(1)
                    ?: return@mapNotNull null
                reported += key
                arguments.remove(key)
                unwrapped
            }
            return fresh.takeIf { it.isNotEmpty() }?.joinToString(", ")
        }

        private companion object {
            const val CALL_TOOL = "call_tool"
            const val MAX_ARGUMENT_CHARS = 4096
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
            JsonObject(mapOf("prompt" to JsonPrimitive(prompt))),
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

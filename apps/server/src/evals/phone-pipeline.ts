/**
 * Brief 03 eval — the phone's run path.
 *
 * The regular eval runner (`run.ts`) drives TrueForge through the SDK. The
 * phone does not: it POSTs to `/api/dashboard/runs` and reads the NDJSON
 * stream. This script is the contract test for that path, parsed exactly the
 * way `TaskRunClient` parses it, so a green run here means the phone client's
 * only remaining risk is its own (unit-tested) parsing.
 *
 *   npm run -w @trueforge-android/server eval:phone            # eval A
 *   npm run -w @trueforge-android/server eval:phone -- --cancel # eval B
 */
import { pathToFileURL } from "node:url";

const DEVICE_API_BASE_URL = process.env.DEVICE_API_BASE_URL ?? "http://127.0.0.1:8792";

const TASK_PROMPT = "Press Home and then report which app is in the foreground.";
const LONG_PROMPT =
  "Open the settings app, then scroll through every settings category slowly, reporting each.";
const RUN_TIMEOUT_MS = 180_000;
const CANCEL_TERMINAL_TIMEOUT_MS = 15_000;

interface Envelope {
  type: string;
  data: Record<string, unknown>;
  /** Wall-clock receipt time, needed by the cancel assertions. */
  at: number;
}

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

function check(checks: Check[], name: string, passed: boolean, detail?: string): boolean {
  checks.push(detail === undefined ? { name, passed } : { name, passed, detail });
  return passed;
}

async function apiJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${DEVICE_API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function preflight(): Promise<{ deviceId: string }> {
  const status = await apiJson("/dashboard/status");
  const devices = Array.isArray(status.devices)
    ? status.devices as Array<Record<string, unknown>>
    : [];
  const deviceId = String(devices[0]?.deviceId ?? "");
  if (!deviceId) throw new Error("No connected Android device");
  return { deviceId };
}

/**
 * Streams a run, parsing NDJSON the way the phone does: split on newlines,
 * JSON-parse non-empty lines, tolerate a trailing partial line, skip
 * anything unparseable. `onEnvelope` may request cancellation mid-stream.
 */
async function streamRun(
  prompt: string,
  onEnvelope?: (envelope: Envelope) => void | Promise<void>,
): Promise<Envelope[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const envelopes: Envelope[] = [];
  try {
    const response = await fetch(`${DEVICE_API_BASE_URL}/api/dashboard/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`POST /api/dashboard/runs returned HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed: { type?: unknown; data?: unknown };
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          continue;
        }
        if (typeof parsed.type !== "string") continue;
        const envelope: Envelope = {
          type: parsed.type,
          data: (parsed.data && typeof parsed.data === "object"
            ? parsed.data
            : {}) as Record<string, unknown>,
          at: Date.now(),
        };
        envelopes.push(envelope);
        if (onEnvelope) await onEnvelope(envelope);
      }
      if (done) break;
    }
  } finally {
    clearTimeout(timeout);
  }
  return envelopes;
}

async function cancelRun(runId: string): Promise<number> {
  const response = await fetch(
    `${DEVICE_API_BASE_URL}/api/dashboard/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  return response.status;
}

function terminalOf(envelopes: Envelope[]): Envelope | undefined {
  return envelopes.find((e) => e.type === "run.completed" || e.type === "run.failed");
}

// --- Eval A ---------------------------------------------------------------

async function evalPhoneRun(): Promise<{ passed: boolean; checks: Check[]; output?: string }> {
  const { deviceId } = await preflight();
  const checks: Check[] = [];
  const envelopes = await streamRun(TASK_PROMPT);
  const types = envelopes.map((e) => e.type);

  const createdIndex = types.indexOf("run.created");
  const startedIndex = types.indexOf("run.started");
  const agentIndex = types.indexOf("agent.event");
  const completed = envelopes.find((e) => e.type === "run.completed");
  const failed = envelopes.find((e) => e.type === "run.failed");

  check(checks, "stream opened with run.created", createdIndex === 0, `types: ${types.slice(0, 3).join(", ")}`);
  check(
    checks,
    "run.started follows and carries a sessionId",
    startedIndex > createdIndex && typeof envelopes[startedIndex]?.data.sessionId === "string",
    String(envelopes[startedIndex]?.data.sessionId ?? "none"),
  );
  check(
    checks,
    "at least one agent.event before the terminal envelope",
    agentIndex > startedIndex,
    `agent.event count: ${types.filter((t) => t === "agent.event").length}`,
  );
  check(
    checks,
    "terminal envelope is run.completed",
    Boolean(completed) && !failed,
    failed ? String(failed.data.error ?? "unknown error") : "ok",
  );
  const output = typeof completed?.data.output === "string" ? completed.data.output : undefined;
  check(
    checks,
    "run.completed carries a non-empty output string",
    Boolean(output && output.trim().length > 0),
    output ? `${output.slice(0, 160)}…` : "no output",
  );

  const stateResponse = await apiJson(`/devices/${encodeURIComponent(deviceId)}/state`);
  const state = stateResponse.ok === true && stateResponse.result && typeof stateResponse.result === "object"
    ? stateResponse.result as Record<string, unknown>
    : null;
  const foreground = String(state?.foregroundPackage ?? "");
  check(
    checks,
    "device ended on the launcher",
    /launcher/i.test(foreground),
    `foregroundPackage: ${foreground || "unknown"}`,
  );

  return { passed: checks.every((c) => c.passed), checks, output };
}

// --- Eval B ---------------------------------------------------------------

async function evalCancel(): Promise<{ passed: boolean; checks: Check[] }> {
  await preflight();
  const checks: Check[] = [];

  let runId: string | undefined;
  let cancelStatus: number | undefined;
  let cancelledAt = 0;
  const envelopes = await streamRun(LONG_PROMPT, async (envelope) => {
    if (envelope.type === "run.started" && !runId) {
      runId = String(envelope.data.id ?? "");
      cancelledAt = Date.now();
      cancelStatus = await cancelRun(runId);
    }
  });

  check(checks, "cancel endpoint accepted the run", cancelStatus === 200, `HTTP ${cancelStatus ?? "none"}`);

  const terminal = terminalOf(envelopes);
  const elapsed = terminal ? terminal.at - cancelledAt : Infinity;
  check(
    checks,
    "stream terminated within 15s of cancel",
    Boolean(terminal) && elapsed <= CANCEL_TERMINAL_TIMEOUT_MS,
    `${Number.isFinite(elapsed) ? `${elapsed}ms` : "never terminated"}`,
  );
  check(
    checks,
    "terminal envelope is run.failed and reads as cancelled",
    terminal?.type === "run.failed" &&
      /cancel/i.test(String(terminal.data.error ?? "")),
    `${terminal?.type ?? "none"}: ${String(terminal?.data.error ?? "")}`,
  );

  const terminalIndex = terminal ? envelopes.indexOf(terminal) : -1;
  const trailingAgentEvents = terminalIndex >= 0
    ? envelopes.slice(terminalIndex + 1).filter((e) => e.type === "agent.event").length
    : 0;
  check(
    checks,
    "no agent.event after the terminal envelope",
    trailingAgentEvents === 0,
    `${trailingAgentEvents} trailing agent.event(s)`,
  );

  // Cancelling a session must not wedge the server for the next run.
  const followUp = await streamRun("Report which app is currently in the foreground.");
  const followUpTerminal = terminalOf(followUp);
  check(
    checks,
    "a fresh run still completes after a cancel",
    followUpTerminal?.type === "run.completed",
    `${followUpTerminal?.type ?? "none"}: ${String(followUpTerminal?.data.error ?? "")}`,
  );

  return { passed: checks.every((c) => c.passed), checks };
}

async function main(): Promise<void> {
  const cancelMode = process.argv.includes("--cancel");
  const id = cancelMode ? "phone-pipeline-cancel" : "phone-pipeline";
  const result = cancelMode ? await evalCancel() : await evalPhoneRun();
  console.log(JSON.stringify({
    eval: id,
    description: cancelMode
      ? "Cancelling a phone-initiated run ends the stream and leaves the server usable"
      : "A run started over the phone's HTTP path streams to completion",
    passed: result.passed,
    checks: result.checks,
    ...("output" in result ? { output: result.output } : {}),
  }, null, 2));
  if (!result.passed) {
    for (const failure of result.checks.filter((c) => !c.passed)) {
      console.error(`FAILED: ${failure.name}${failure.detail ? ` — ${failure.detail}` : ""}`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("EVAL FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import { pathToFileURL } from "node:url";
import { runTurnLoopWithApprovals } from "../approvals/turn-loop.js";
import { config } from "../config.js";
import { ANDROID_TOOL_BRIDGE_NAME } from "../mcp/android-tools.js";
import { createDeviceTarget } from "../devices/target.js";
import { trueForgeClient } from "../trueforge/client.js";
import {
  ensureAgent,
  registerMcpServer,
  registerModelProvider,
  sandboxAvailable,
} from "../trueforge/setup.js";
import { evalCases } from "./cases/index.js";
import type { AndroidEvalCase, EvalContext, ToolTraceEntry } from "./types.js";

const DEVICE_API_BASE_URL = process.env.DEVICE_API_BASE_URL ?? "http://127.0.0.1:8792";

async function apiJson(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${DEVICE_API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function unwrapDeviceResponse(response: Record<string, unknown>): Record<string, unknown> | null {
  return response.ok === true && response.result && typeof response.result === "object"
    ? response.result as Record<string, unknown>
    : null;
}

function unwrapDeviceList(
  response: Record<string, unknown>,
): Array<Record<string, unknown>> | null {
  if (response.ok !== true || !Array.isArray(response.result)) return null;
  return response.result.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === "object",
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function decodeToolResult(content: string): unknown {
  const outer = parseJson(content);
  if (!outer || typeof outer !== "object") return outer;
  const blocks = (outer as { content?: unknown }).content;
  if (!Array.isArray(blocks)) return outer;
  const texts = blocks.flatMap((block) =>
    block && typeof block === "object" && (block as { type?: unknown }).type === "text"
      ? [String((block as { text?: unknown }).text ?? "")]
      : [],
  );
  if (texts.length === 1) return parseJson(texts[0]!);
  return texts.length > 0 ? texts.map(parseJson) : outer;
}

export function assembleToolTrace(events: TrueForgeApi.TurnStreamingEvent[]): ToolTraceEntry[] {
  const messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
  const responses = new Map<string, unknown>();
  for (const event of events) {
    if (isEventDelta(event)) {
      const base = messages.get(event.id);
      if (base) mergeEventDelta(base, event);
      continue;
    }
    if (event.type === "model.message") messages.set(event.id, structuredClone(event));
    if (event.type === "tool.response") {
      responses.set(event.toolCallId, decodeToolResult(event.content));
    }
  }

  return [...messages.values()].flatMap((message) => (message.toolCalls ?? []).map((call) => {
    const parsed = parseJson(call.function.arguments || "{}");
    const args = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    const wrapped = call.function.name === "call_tool";
    return {
      id: call.id,
      toolName: wrapped ? String(args.tool_name ?? "unknown") : call.function.name,
      input: args,
      result: responses.get(call.id),
    };
  }));
}

async function preflight(): Promise<{ deviceId: string }> {
  const status = await apiJson("/dashboard/status");
  const devices = Array.isArray(status.devices)
    ? status.devices as Array<Record<string, unknown>>
    : [];
  const deviceId = String(devices[0]?.deviceId ?? "");
  if (!deviceId) throw new Error("No connected Android device");
  const media = unwrapDeviceResponse(await apiJson(`/devices/${encodeURIComponent(deviceId)}/media`));
  if (media?.available !== true) {
    throw new Error(
      "Android media sessions are unavailable. Open TrueForge Operator and enable media session access.",
    );
  }
  return { deviceId };
}

async function runCase(testCase: AndroidEvalCase): Promise<boolean> {
  const { deviceId } = await preflight();
  const client = trueForgeClient();
  await registerModelProvider();
  await registerMcpServer(
    ANDROID_TOOL_BRIDGE_NAME,
    `http://${config.mcpHost}:${config.mcpPort}/mcp`,
    "Physical Android control with accessibility and authoritative media-session tooling.",
  );
  const evalAgentName = `${config.agentName}-eval`;
  await ensureAgent({
    agentName: evalAgentName,
    mcpServerName: ANDROID_TOOL_BRIDGE_NAME,
    sandbox: sandboxAvailable(),
  });
  const session = await client.sessions.create({ agent: { name: evalAgentName } });

  const timeout = setTimeout(() => {
    void client.sessions.cancel(session.data.id, {});
  }, testCase.timeoutMs);
  let loop;
  try {
    // Same pause/resume cycle the dashboard runs, with the eval case standing
    // in for the human so nothing waits on a phone.
    loop = await runTurnLoopWithApprovals({
      client,
      sessionId: session.data.id,
      prompt: `[System routing context: include deviceTarget ` +
        `"${createDeviceTarget(deviceId)}" in every ` +
        `android-tool-bridge call.]\n\n${testCase.prompt}`,
      decide: async (info) => {
        const decision = testCase.approvalDecision?.({
          intent: info.intent,
          toolName: info.toolName,
          action: info.action,
        }) ?? "deny";
        return decision === "allow"
          ? { decision: "allow" }
          : { decision: "deny", reason: "Eval harness denied the action" };
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  const events = loop.events;
  const output = loop.output;
  const finalDeviceState = unwrapDeviceResponse(await apiJson(`/devices/${encodeURIComponent(deviceId)}/state`));
  const finalMediaState = unwrapDeviceResponse(await apiJson(`/devices/${encodeURIComponent(deviceId)}/media`));
  const finalNotifications = unwrapDeviceList(
    await apiJson(`/devices/${encodeURIComponent(deviceId)}/notifications`),
  );
  const toolCalls = assembleToolTrace(events);
  const context: EvalContext = {
    prompt: testCase.prompt,
    output,
    turnStatus: loop.turnStatus,
    turnError: loop.turnError,
    toolCalls,
    events,
    approvals: loop.approvals,
    finalDeviceState,
    finalMediaState,
    finalNotifications,
  };
  const checks = testCase.checks(context);
  const passed = checks.every((result) => result.passed);
  const compactToolCalls = toolCalls.map((call) => ({
    id: call.id,
    toolName: call.toolName,
    input: call.input,
    result: call.result && typeof call.result === "object"
      ? summarizeResult(call.result as Record<string, unknown>)
      : call.result,
  }));
  console.log(JSON.stringify({
    eval: testCase.id,
    description: testCase.description,
    passed,
    sessionId: session.data.id,
    checks,
    approvals: context.approvals,
    toolCalls: compactToolCalls,
    output,
  }, null, 2));
  return passed;
}

function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of [
    "status", "matched", "available", "permissionRequired", "packageName",
    "foregroundPackage", "snapshotId", "screenChanged", "latencyMs",
  ]) {
    if (key in result) summary[key] = result[key];
  }
  if (Array.isArray(result.sessions)) summary.sessions = result.sessions;
  if (result.action && typeof result.action === "object") {
    const action = result.action as Record<string, unknown>;
    summary.action = {
      status: action.status,
      screenChanged: action.screenChanged,
      foregroundPackage: action.foregroundPackage,
      latencyMs: action.latencyMs,
    };
  }
  if (result.screen && typeof result.screen === "object") {
    const screen = result.screen as Record<string, unknown>;
    summary.screen = {
      snapshotId: screen.snapshotId,
      packageName: screen.packageName,
      nodeCount: screen.nodeCount,
    };
  }
  if (Array.isArray(result.matches)) summary.matchCount = result.matches.length;
  if (Array.isArray(result.nodes)) summary.nodeCount = result.nodes.length;
  if (Object.keys(summary).length === 0) summary.kind = "omitted-large-result";
  return summary;
}

async function main(): Promise<void> {
  const requested = process.argv[2];
  const selected = requested ? evalCases.filter((testCase) => testCase.id === requested) : evalCases;
  if (selected.length === 0) {
    throw new Error(`Unknown eval '${requested}'. Available: ${evalCases.map((item) => item.id).join(", ")}`);
  }
  let passed = true;
  for (const testCase of selected) passed = await runCase(testCase) && passed;
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("EVAL FAILED:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

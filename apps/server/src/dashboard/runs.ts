import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { requestPhoneApproval } from "../approvals/phone.js";
import { requestPhoneAnswer } from "../questions/phone.js";
import { runTurnLoopWithApprovals } from "../approvals/turn-loop.js";
import type { DeviceGateway } from "../devices/gateway.js";
import { createDeviceTarget } from "../devices/target.js";
import { config } from "../config.js";
import { ANDROID_TOOL_BRIDGE_NAME } from "../mcp/android-tools.js";
import { trueForgeClient } from "../trueforge/client.js";
import {
  addMetrics,
  buildTranscriptFromSession,
  TranscriptBuilder,
  type SessionTranscript,
  type TranscriptItem,
  type TurnMetricsSummary,
} from "./transcript.js";
import {
  ANDROID_OPERATOR_INSTRUCTIONS,
  ensureAgent,
  AGENT_ITERATION_LIMIT,
  registerMcpServer,
  registerModelProvider,
  sandboxAvailable,
} from "../trueforge/setup.js";
import {
  reasoningSettings,
  REASONING_EFFORTS,
  updateReasoningSettings,
  type ReasoningEffort,
} from "../trueforge/reasoning.js";

export const CANCELLED_MESSAGE = "cancelled by user";

/** Raw events kept per live run, so the Logs tab stays bounded. */
const MAX_RAW_EVENTS = 4000;

export interface DashboardRun {
  id: string;
  deviceId?: string;
  sessionId?: string;
  prompt: string;
  /** First prompt of the conversation; the sidebar label. */
  title: string;
  status: "starting" | "running" | "completed" | "failed" | "archived";
  /** True for a run recovered from TrueForge history rather than this process. */
  historical?: boolean;
  startedAt: string;
  finishedAt?: string;
  eventCount: number;
  /** Prompts sent on this session so far, including follow-ups. */
  turnCount: number;
  output?: string;
  error?: string;
  metrics?: TurnMetricsSummary | null;
}

const runs: DashboardRun[] = [];
let agentReady: Promise<void> | null = null;

type Envelope = { type: string; data: unknown };

/**
 * A run currently streaming from TrueForge.
 *
 * The transcript is built here rather than in the browser so that a reload, a
 * second viewer, or the phone all see the same thing, and so history and live
 * views share one representation.
 */
interface ActiveRun {
  sessionId: string;
  cancelled: boolean;
  builder: TranscriptBuilder;
  raw: TrueForgeApi.TurnStreamingEvent[];
  subscribers: Set<(envelope: Envelope) => void>;
}
const activeRuns = new Map<string, ActiveRun>();

/**
 * Transcript builders keyed by run id, kept after the run ends.
 *
 * Holding the builder (rather than a snapshot of its items) is what lets a
 * follow-up prompt append to the same transcript, with turn numbering and
 * tool-call correlation carried over from the earlier turns.
 */
const builders = new Map<string, TranscriptBuilder>();

function targetBoundPrompt(prompt: string, deviceId: string): string {
  const deviceTarget = createDeviceTarget(deviceId);
  return `[System routing context: operate only the run-bound Android device. Include ` +
    `deviceTarget "${deviceTarget}" in every android-tool-bridge call. If you create a ` +
    `vision-recovery sub-agent, copy this exact opaque deviceTarget into its input; child ` +
    `agents do not inherit this routing context.]\n\n${prompt}`;
}

export function listDashboardRuns(): DashboardRun[] {
  return runs.slice(0, 20);
}

let agentIdCache: string | null = null;

async function operatorAgentId(): Promise<string | null> {
  if (agentIdCache) return agentIdCache;
  const listed = await trueForgeClient().agents.list();
  agentIdCache = listed.data.find((agent) => agent.name === config.agentName)?.id ?? null;
  return agentIdCache;
}

/**
 * Recent runs, including sessions this process did not start.
 *
 * In-memory runs only survive a restart of this server, while TrueForge keeps
 * every session it ever ran. Merging the two is what lets an operator open
 * yesterday's run — and a run started from the phone — and read its transcript.
 */
export async function listDashboardRunsWithHistory(): Promise<DashboardRun[]> {
  const live = listDashboardRuns();
  try {
    const agentId = await operatorAgentId();
    if (!agentId) return live;
    const known = new Set(live.map((run) => run.sessionId).filter(Boolean));
    const page = await trueForgeClient().sessions.list({ limit: 25, agentId });
    const historical: DashboardRun[] = [];
    for await (const session of page) {
      if (known.has(session.id) || historical.length >= 25) continue;
      historical.push({
        id: session.id,
        sessionId: session.id,
        prompt: session.title ?? "",
        title: session.title ?? session.id,
        // The list endpoint carries no outcome; the transcript view resolves it.
        status: "archived",
        historical: true,
        startedAt: session.createdAt,
        finishedAt: session.updatedAt,
        eventCount: 0,
        turnCount: 0,
      });
    }
    return [...live, ...historical];
  } catch {
    // History is a convenience; a runtime hiccup must not empty the sidebar.
    return live;
  }
}

export function findDashboardRun(runId: string): DashboardRun | undefined {
  return runs.find((run) => run.id === runId || run.sessionId === runId);
}

export function isRunLive(runId: string): boolean {
  return activeRuns.has(findDashboardRun(runId)?.id ?? runId);
}

/**
 * Cancels the TrueForge session behind a run. Returns false when the run is
 * unknown or already finished. The in-flight turn stream then ends; the run
 * surfaces as `run.failed` with "cancelled by user" rather than a crash.
 */
export async function cancelDashboardRun(runId: string): Promise<boolean> {
  const active = activeRuns.get(runId);
  if (!active) return false;
  active.cancelled = true;
  await trueForgeClient().sessions.cancel(active.sessionId, {});
  return true;
}

function prepareAgent(): Promise<void> {
  if (!agentReady) {
    agentReady = (async () => {
      await registerModelProvider();
      const bridgeUrl = `http://${config.mcpHost}:${config.mcpPort}/mcp`;
      await registerMcpServer(
        ANDROID_TOOL_BRIDGE_NAME,
        bridgeUrl,
        "Physical Android device control: accessibility snapshots, generic actions, screenshots, device state.",
      );
      await ensureAgent({
        agentName: config.agentName,
        mcpServerName: ANDROID_TOOL_BRIDGE_NAME,
        sandbox: sandboxAvailable(),
      });
    })().catch((error) => {
      agentReady = null;
      throw error;
    });
  }
  return agentReady;
}

/**
 * Applies a new reasoning level.
 *
 * The agent's effort lives on its manifest, so it takes a manifest write to
 * change and only affects turns created afterwards - an in-flight turn keeps
 * the level it started with. The vision level is read per call and so takes
 * effect immediately. Nothing is written when the value did not move.
 */
let reasoningUpdateQueue: Promise<void> = Promise.resolve();

async function applyReasoningSettingsSerial(patch: {
  agent?: ReasoningEffort;
  vision?: ReasoningEffort;
}): Promise<{ settings: ReturnType<typeof reasoningSettings>; applied: boolean }> {
  const previous = reasoningSettings();
  const { settings, changed } = updateReasoningSettings(patch);
  if (!changed.includes("agent")) return { settings, applied: false };
  // Deliberately not gated on `agentReady`: the level must stick even if the
  // agent has not been prepared yet in this process, and ensureAgent is an
  // idempotent create-or-update.
  try {
    await prepareAgent();
    await ensureAgent({
      agentName: config.agentName,
      mcpServerName: ANDROID_TOOL_BRIDGE_NAME,
      sandbox: sandboxAvailable(),
      reasoningEffort: settings.agent,
    });
  } catch (error) {
    // Vision is local and may apply independently, but an agent value is only
    // committed after the matching manifest write succeeds. Rolling it back
    // also makes an identical retry attempt the write again.
    updateReasoningSettings({ agent: previous.agent });
    throw error;
  }
  return { settings, applied: true };
}

export function applyReasoningSettings(patch: {
  agent?: ReasoningEffort;
  vision?: ReasoningEffort;
}): Promise<{ settings: ReturnType<typeof reasoningSettings>; applied: boolean }> {
  const operation = reasoningUpdateQueue.then(() => applyReasoningSettingsSerial(patch));
  reasoningUpdateQueue = operation.then(() => undefined, () => undefined);
  return operation;
}

/** Current reasoning levels and the values the provider will accept. */
export function describeReasoning(): Record<string, unknown> {
  return {
    ...reasoningSettings(),
    options: [...REASONING_EFFORTS],
  };
}

/** Static description of the agent the dashboard drives (system prompt included). */
export function describeAgent(): Record<string, unknown> {
  return {
    name: config.agentName,
    model: `${config.modelProviderName}/${config.mainModelId}`,
    visionModel: config.visionModelId,
    reasoning: reasoningSettings(),
    mcpServer: ANDROID_TOOL_BRIDGE_NAME,
    sandbox: sandboxAvailable(),
    gatedTools: ["commit_action"],
    subAgents: true,
    iterationLimit: AGENT_ITERATION_LIMIT,
    instructions: ANDROID_OPERATOR_INSTRUCTIONS,
  };
}

function writeEvent(res: ServerResponse, type: string, data: unknown): void {
  res.write(`${JSON.stringify({ type, data })}\n`);
}

/**
 * Streams a run's transcript to a viewer that did not start it.
 *
 * Live runs replay the transcript so far and then follow along; finished ones
 * are rebuilt from TrueForge's own persisted events, which is what makes an
 * old run show its own tool chain instead of the newest run's.
 */
export async function streamRunTranscript(
  runId: string,
  res: ServerResponse,
): Promise<void> {
  const run = findDashboardRun(runId);
  const active = run ? activeRuns.get(run.id) : undefined;
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  if (active) {
    writeEvent(res, "run.snapshot", {
      run,
      items: active.builder.items(),
      live: true,
    });
    const send = (envelope: Envelope): void => {
      writeEvent(res, envelope.type, envelope.data);
    };
    active.subscribers.add(send);
    res.on("close", () => active.subscribers.delete(send));
    await new Promise<void>((resolve) => res.on("close", resolve));
    return;
  }

  const cached = run ? builders.get(run.id) : undefined;
  if (cached && run) {
    writeEvent(res, "run.snapshot", { run, items: cached.items(), live: false });
    res.end();
    return;
  }

  try {
    const sessionId = run?.sessionId ?? runId;
    const transcript = await buildTranscriptFromSession(trueForgeClient(), sessionId);
    writeEvent(res, "run.snapshot", {
      run: run ?? runFromHistory(sessionId, transcript),
      items: transcript.items,
      turns: transcript.turns,
      metrics: transcript.metrics,
      live: false,
    });
  } catch (error) {
    writeEvent(res, "run.snapshot.error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  res.end();
}

function runFromHistory(sessionId: string, transcript: SessionTranscript): DashboardRun {
  const first = transcript.turns[0];
  const last = transcript.turns.at(-1);
  // Turn rows only carry their start; the run really ended with its last
  // event, which is what makes the reported duration something other than 0s.
  const lastEventAt = transcript.items.reduce(
    (latest, item) => (item.at > latest ? item.at : latest),
    last?.createdAt ?? "",
  );
  return {
    id: sessionId,
    sessionId,
    historical: true,
    prompt: last?.prompt ?? "",
    title: first?.prompt ?? sessionId,
    status: last?.status === "error" ? "failed" : "completed",
    startedAt: first?.createdAt ?? new Date().toISOString(),
    finishedAt: lastEventAt || last?.createdAt,
    eventCount: transcript.items.length,
    turnCount: transcript.turns.length,
    output: transcript.output,
    metrics: transcript.metrics,
  };
}

/** Raw TrueForge events for a run, for the Logs tab. */
export async function getRunRawEvents(
  runId: string,
): Promise<{ events: unknown[]; live: boolean }> {
  const run = findDashboardRun(runId);
  const active = run ? activeRuns.get(run.id) : undefined;
  if (active) return { events: active.raw, live: true };
  const sessionId = run?.sessionId ?? runId;
  const events: unknown[] = [];
  const page = await trueForgeClient().sessions.listEvents(sessionId, { limit: 100 });
  for await (const item of page) events.push(item);
  return { events, live: false };
}

/** Cross-run totals for the analytics panel. */
export function dashboardAnalytics(): Record<string, unknown> {
  const finished = runs.filter((run) => run.status === "completed" || run.status === "failed");
  const metrics = finished.reduce<TurnMetricsSummary | null>(
    (total, run) => addMetrics(total, run.metrics ?? null),
    null,
  );
  const durations = finished
    .filter((run) => run.finishedAt)
    .map((run) => Date.parse(run.finishedAt!) - Date.parse(run.startedAt))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  return {
    runs: runs.length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
    live: activeRuns.size,
    turns: runs.reduce((total, run) => total + run.turnCount, 0),
    metrics,
    medianDurationMs: median(durations),
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

export interface StreamRunOptions {
  /** Continue this run's TrueForge session instead of creating a new one. */
  runId?: string;
  /** Device selected when the run was created. Immutable across follow-ups. */
  deviceId: string;
}

export async function streamDashboardRun(
  prompt: string,
  res: ServerResponse,
  gateway: DeviceGateway,
  options: StreamRunOptions,
): Promise<void> {
  // A follow-up prompt must land on the same TrueForge session, or the agent
  // loses everything it just observed on the device and starts from scratch.
  const existing = options.runId ? findDashboardRun(options.runId) : undefined;
  if (existing?.deviceId && existing.deviceId !== options.deviceId) {
    throw new Error(
      `Run '${existing.id}' is bound to device '${existing.deviceId}', not '${options.deviceId}'`,
    );
  }
  const continuing = Boolean(existing?.sessionId) && !activeRuns.has(existing!.id);

  const run: DashboardRun = continuing
    ? existing!
    : {
      id: randomUUID(),
      deviceId: options.deviceId,
      prompt,
      title: prompt,
      status: "starting",
      startedAt: new Date().toISOString(),
      eventCount: 0,
      turnCount: 0,
    };
  if (continuing) {
    run.deviceId ??= options.deviceId;
    run.prompt = prompt;
    run.status = "starting";
    run.finishedAt = undefined;
    run.error = undefined;
    run.output = undefined;
  } else {
    runs.unshift(run);
    if (runs.length > 20) {
      for (const dropped of runs.splice(20)) builders.delete(dropped.id);
    }
  }

  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });

  // The builder survives across follow-up turns so a continued conversation
  // reads as one transcript rather than a series of unrelated runs.
  const builder = (continuing ? builders.get(run.id) : undefined) ?? new TranscriptBuilder();
  builders.set(run.id, builder);
  const active: ActiveRun = {
    sessionId: run.sessionId ?? "",
    cancelled: false,
    builder,
    raw: [],
    subscribers: new Set(),
  };
  activeRuns.set(run.id, active);

  const priorItems = continuing ? builder.items() : [];
  const broadcast = (type: string, data: unknown): void => {
    writeEvent(res, type, data);
    for (const subscriber of active.subscribers) subscriber({ type, data });
  };
  // Raw TrueForge events stay on the primary response, which the phone and the
  // eval runner consume; attached viewers only need the folded transcript.
  const emitRaw = (type: string, data: unknown): void => writeEvent(res, type, data);
  const emitItems = (items: TranscriptItem[]): void => {
    for (const item of items) broadcast("transcript.item", item);
  };

  broadcast("run.created", run);
  // Replay the earlier turns so a continued run opens as one conversation.
  for (const item of priorItems) writeEvent(res, "transcript.item", item);
  emitItems(builder.beginTurn(prompt, run.startedAt));

  try {
    await prepareAgent();
    const client = trueForgeClient();
    if (!run.sessionId) {
      const session = await client.sessions.create({ agent: { name: config.agentName } });
      run.sessionId = session.data.id;
    }
    active.sessionId = run.sessionId;
    run.status = "running";
    run.turnCount += 1;
    broadcast("run.started", run);

    // The turn pauses whenever the agent calls commit_action; the phone is the
    // approval surface and the NDJSON response stays open across resumes.
    const result = await runTurnLoopWithApprovals({
      client,
      sessionId: run.sessionId,
      prompt: targetBoundPrompt(prompt, run.deviceId!),
      onEvent: (event) => {
        run.eventCount += 1;
        if (active.raw.length < MAX_RAW_EVENTS) active.raw.push(event);
        emitRaw("agent.event", event);
        emitItems(builder.push(event));
      },
      onPending: (info) => {
        broadcast("approval.pending", {
          runId: run.id,
          toolCallId: info.toolCallId,
          intent: info.intent,
        });
        emitItems(builder.approvalPending(info.toolCallId, info.intent));
      },
      decide: (info) => requestPhoneApproval(gateway, run.deviceId!, info),
      answer: (info) => requestPhoneAnswer(gateway, run.deviceId!, info),
      onQuestionPending: (info) => {
        broadcast("question.pending", {
          runId: run.id,
          toolCallId: info.toolCallId,
          question: info.question,
          options: info.options,
        });
      },
      onQuestionAnswered: (info, outcome) => {
        broadcast("question.answered", {
          runId: run.id,
          toolCallId: info.toolCallId,
          answer: outcome.content,
        });
      },
      onDecided: (info, outcome) => {
        broadcast("approval.decided", {
          runId: run.id,
          toolCallId: info.toolCallId,
          intent: info.intent,
          decision: outcome.decision,
          reason: outcome.reason ?? null,
        });
        emitItems(builder.approvalDecided(
          info.toolCallId,
          info.intent,
          outcome.decision,
          outcome.reason ?? null,
        ));
      },
      onResume: () => builder.beginApprovalTurn(),
    });

    if (active.cancelled) throw new Error(CANCELLED_MESSAGE);
    if (result.turnError) throw new Error(result.turnError);
    if (result.output) run.output = result.output;
    run.metrics = addMetrics(run.metrics ?? null, collectMetrics(result.events));

    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    broadcast("run.completed", run);
  } catch (error) {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    run.error = active.cancelled
      ? CANCELLED_MESSAGE
      : error instanceof Error ? error.message : String(error);
    emitItems(builder.runError(run.error));
    broadcast("run.failed", run);
  } finally {
    activeRuns.delete(run.id);
    for (const subscriber of active.subscribers) {
      subscriber({ type: "run.stream.end", data: { runId: run.id } });
    }
    active.subscribers.clear();
    res.end();
  }
}

function collectMetrics(
  events: TrueForgeApi.TurnStreamingEvent[],
): TurnMetricsSummary | null {
  let total: TurnMetricsSummary | null = null;
  for (const event of events) {
    if (event.type !== "turn.done") continue;
    if (!("metrics" in event.state)) continue;
    const metrics = event.state.metrics;
    if (!metrics) continue;
    total = addMetrics(total, {
      inputTokens: metrics.totalInputTokens ?? 0,
      outputTokens: metrics.totalOutputTokens ?? 0,
      totalTokens: metrics.totalTokens ?? 0,
      cacheReadTokens: metrics.totalCacheReadTokens ?? 0,
      cacheWriteTokens: metrics.totalCacheWriteTokens ?? 0,
      reasoningTokens: metrics.totalReasoningTokens ?? 0,
      costUsd: metrics.totalCostInUsd ?? null,
    });
  }
  return total;
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpExpressApp,
} from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PROTOCOL_VERSION } from "@trueforge-android/protocol";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inspectScreenVisually } from "../vision/inspect.js";
import { frameReference, storeFrame } from "../media/frames.js";
import type { VisionCaller } from "../vision/client.js";
import { resolveDeviceTarget } from "../devices/target.js";

/**
 * Android Tool Bridge (handoff doc sections 10 and 11).
 *
 * MCP is the TrueForge-facing protocol; this server forwards generic device
 * primitives over the WebSocket gateway to the physical phone. The tool
 * surface is intentionally small and app agnostic.
 */

export const ANDROID_TOOL_BRIDGE_NAME = "android-tool-bridge";

const DeviceActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click_node"), snapshotId: z.string(), nodeId: z.string() }),
  z.object({ type: z.literal("long_click_node"), snapshotId: z.string(), nodeId: z.string() }),
  z.object({
    type: z.literal("set_text"),
    snapshotId: z.string(),
    nodeId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("scroll"),
    snapshotId: z.string(),
    direction: z.enum(["up", "down", "left", "right"]),
    nodeId: z.string().optional(),
  }),
  z.object({
    type: z.literal("tap_coordinates"),
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("swipe"),
    startX: z.number().int().nonnegative(),
    startY: z.number().int().nonnegative(),
    endX: z.number().int().nonnegative(),
    endY: z.number().int().nonnegative(),
    durationMs: z.number().int().positive().default(300),
  }),
  z.object({
    type: z.literal("global_action"),
    action: z.enum([
      "back", "home", "recents", "notifications", "quick_settings",
      "power_dialog", "lock_screen", "screenshot", "dpad_up", "dpad_down",
      "dpad_left", "dpad_right", "dpad_center",
    ]),
  }),
  z.object({
    type: z.literal("launch_app"),
    packageName: z.string(),
  }),
  z.object({
    type: z.literal("media_control"),
    action: z.enum(["play", "pause", "stop", "next", "previous"]),
    packageName: z.string().optional(),
  }),
  z.object({
    type: z.literal("notification_action"),
    key: z.string(),
    action: z.enum(["open", "dismiss", "invoke"]),
    actionIndex: z.number().int().nonnegative().optional(),
  }),
]);

type DeviceAction = z.infer<typeof DeviceActionSchema>;

export interface DeviceGatewayLike {
  listDevices(): Array<{ deviceId: string }>;
  isOnline(deviceId: string): boolean;
  sendRequest(
    deviceId: string,
    request: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

/**
 * Actions that must not run through the ungated tools.
 *
 * Instructions alone stopped being enough once Code Mode landed: a script in
 * the sandbox can call `execute_action` in a loop without a model turn per
 * call, so an agent that ignores the operating policy routes around the
 * approval gate entirely and nothing pauses. Refusing here makes the boundary
 * structural — the consequential path only exists on `commit_action`, which
 * TrueForge gates.
 */
function assertNotConsequential(action: DeviceAction): void {
  if (action.type === "notification_action" && action.action !== "open") {
    throw new Error(
      `notification_action '${action.action}' is consequential: it acts on someone else's ` +
      "notification. Call commit_action with a one-sentence intent instead; it pauses for " +
      "human approval. This also applies to calls made from a sandbox script.",
    );
  }
}

const DeviceTargetSchema = z.string().min(1).describe("The opaque deviceTarget bound to this run");

function requireOnlineDevice(gateway: DeviceGatewayLike, deviceTarget: string): string {
  const deviceId = resolveDeviceTarget(deviceTarget);
  if (!gateway.listDevices().some((device) => device.deviceId === deviceId)) {
    throw new Error(`Unknown Android device '${deviceId}'`);
  }
  if (!gateway.isOnline(deviceId)) throw new Error(`Selected Android device '${deviceId}' is offline`);
  return deviceId;
}

const MAX_TEXT_LEN = 80;
const MAX_NODES = 60;

interface RawSnapNode {
  id: string;
  parentId?: string | null;
  className?: string | null;
  viewId?: string | null;
  text?: string | null;
  contentDescription?: string | null;
  bounds: [number, number, number, number];
  clickable?: boolean;
  longClickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
  focusable?: boolean;
  enabled?: boolean;
  selected?: boolean;
  checked?: boolean | null;
  actions?: string[];
  range?: { min: number; max: number; current: number } | null;
}

interface RawSnapshot {
  deviceId: string;
  snapshotId: string;
  packageName: string;
  windowTitle?: string | null;
  timestamp: number;
  nodes: RawSnapNode[];
}

/**
 * Model-facing compaction (handoff doc sections 14 and 42): the wire protocol
 * keeps full fidelity between phone and server; the model sees a terse form.
 */
export function compactSnapshot(raw: RawSnapshot): Record<string, unknown> {
  const truncated = raw.nodes.length > MAX_NODES;
  const kept = truncated ? raw.nodes.slice(0, MAX_NODES) : raw.nodes;
  const cap = (s: string | null | undefined): string | null => {
    if (!s) return null;
    return s.length > MAX_TEXT_LEN ? `${s.slice(0, MAX_TEXT_LEN)}…` : s;
  };
  return {
    snapshotId: raw.snapshotId,
    packageName: raw.packageName,
    windowTitle: raw.windowTitle ?? null,
    nodeCount: raw.nodes.length,
    truncated,
    nodes: kept.map((n) => {
      let flags = "";
      if (n.clickable) flags += "c";
      if (n.longClickable) flags += "l";
      if (n.editable) flags += "e";
      if (n.scrollable) flags += "s";
      const o: Record<string, unknown> = { id: n.id };
      if (n.parentId != null) o.p = n.parentId;
      const t = cap(n.text);
      if (t != null) o.t = t;
      const d = cap(n.contentDescription);
      if (d != null) o.d = d;
      if (n.className) o.r = n.className.split(".").at(-1);
      if (n.viewId) o.v = n.viewId.split(":id/").at(-1);
      if (flags) o.f = flags;
      if (n.actions?.length) o.a = n.actions;
      if (n.selected) o.sel = true;
      if (n.checked != null) o.chk = n.checked;
      if (n.enabled === false) o.dis = true;
      if (n.range) o.rng = [n.range.min, n.range.max, n.range.current];
      o.b = n.bounds;
      return o;
    }),
  };
}

/**
 * Recently observed snapshots, so a stale node action can be re-targeted.
 *
 * The phone keeps exactly one live snapshot: every `get_screen` replaces it,
 * and `find_nodes`, `execute_and_observe` and `wait_for` all take one
 * internally. So an agent that observes, searches, then acts is holding an id
 * the device has already discarded, and the action comes back
 * `stale_snapshot` having done nothing. That cost real iterations on the
 * Amazon runs. Node ids are positional within their snapshot, so replaying the
 * same id against the fresh one could hit a different node - we keep the
 * observed trees here instead and re-resolve by node identity.
 */
const snapshotCache = new Map<string, RawSnapshot>();
const MAX_CACHED_SNAPSHOTS = 12;

function rememberSnapshot(deviceId: string, raw: RawSnapshot): RawSnapshot {
  const key = `${deviceId}:${raw.snapshotId}`;
  snapshotCache.delete(key);
  snapshotCache.set(key, raw);
  while (snapshotCache.size > MAX_CACHED_SNAPSHOTS) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest === undefined) break;
    snapshotCache.delete(oldest);
  }
  return raw;
}

/** Exported for tests: the cache is process-wide and must not leak between them. */
export function clearSnapshotCache(): void {
  snapshotCache.clear();
}

/**
 * What makes a node the *same* node across two observations of one screen.
 *
 * Deliberately excludes bounds and id: a scroll moves a row and renumbers the
 * tree, but the label, view id and class of the thing the agent chose do not
 * change. An empty signature identifies nothing, so it never matches.
 */
function nodeIdentity(node: RawSnapNode): string | null {
  const parts = [
    node.className ?? "",
    node.viewId ?? "",
    node.text ?? "",
    node.contentDescription ?? "",
  ];
  return parts.some((p) => p !== "") ? parts.join(" ") : null;
}

interface StaleRecovery {
  /** The same action, re-pointed at the snapshot the device currently holds. */
  action: DeviceAction;
  fromSnapshotId: string;
  toSnapshotId: string;
  fromNodeId?: string;
  toNodeId?: string;
}

function isStaleSnapshot(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { status?: unknown }).status === "stale_snapshot"
  );
}

/**
 * Re-points a node action at the device's current snapshot, or gives up.
 *
 * Only an unambiguous match is accepted: if the node the agent named is gone,
 * or its identity now matches several nodes, we return null and the caller
 * surfaces the original `stale_snapshot` rather than acting on a guess.
 */
async function reResolveStaleAction(
  gateway: DeviceGatewayLike,
  deviceId: string,
  action: DeviceAction,
): Promise<StaleRecovery | null> {
  if (!("snapshotId" in action)) return null;
  const fromSnapshotId = action.snapshotId;

  const fresh = rememberSnapshot(
    deviceId,
    unwrap(await gateway.sendRequest(deviceId, { type: "get_screen" })) as RawSnapshot,
  );
  if (fresh.snapshotId === fromSnapshotId) return null;

  // A scroll without a node targets the screen's default scrollable; there is
  // no node identity to preserve, so the fresh id is enough.
  const nodeId = "nodeId" in action ? action.nodeId : undefined;
  if (nodeId === undefined) {
    return {
      action: { ...action, snapshotId: fresh.snapshotId },
      fromSnapshotId,
      toSnapshotId: fresh.snapshotId,
    };
  }

  const previous = snapshotCache.get(`${deviceId}:${fromSnapshotId}`);
  const target = previous?.nodes.find((node) => node.id === nodeId);
  const identity = target ? nodeIdentity(target) : null;
  if (!identity) return null;

  const matches = fresh.nodes.filter((node) => nodeIdentity(node) === identity);
  const match = matches.length === 1 ? matches[0] : undefined;
  if (!match) return null;

  return {
    action: { ...action, snapshotId: fresh.snapshotId, nodeId: match.id },
    fromSnapshotId,
    toSnapshotId: fresh.snapshotId,
    fromNodeId: nodeId,
    toNodeId: match.id,
  };
}

/**
 * Runs one action, retrying once against a fresh snapshot if the device
 * reports the caller's snapshot stale. The retry re-resolves the node by
 * identity, so it either acts on the same element or does not act at all.
 */
async function executeWithStaleRecovery(
  gateway: DeviceGatewayLike,
  deviceId: string,
  action: DeviceAction,
): Promise<{ result: unknown; recovery?: Omit<StaleRecovery, "action"> }> {
  const result = unwrap(await gateway.sendRequest(deviceId, { type: "execute_action", action }));
  if (!isStaleSnapshot(result)) return { result };

  const recovery = await reResolveStaleAction(gateway, deviceId, action);
  if (!recovery) return { result };

  const { action: retried, ...detail } = recovery;
  const retryResult = unwrap(
    await gateway.sendRequest(deviceId, { type: "execute_action", action: retried }),
  );
  return { result: retryResult, recovery: detail };
}

function unwrap(response: Record<string, unknown>): unknown {
  if (response.ok !== true) {
    const err = response.error;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err ?? response));
  }
  return response.result;
}

function nodeSearchText(node: RawSnapNode): string {
  return [node.text, node.contentDescription, node.className, node.viewId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function compactMatch(node: RawSnapNode): Record<string, unknown> {
  const snapshot: RawSnapshot = {
    deviceId: "search",
    snapshotId: "search",
    packageName: "search",
    timestamp: 0,
    nodes: [node],
  };
  return (compactSnapshot(snapshot).nodes as Record<string, unknown>[])[0] ?? { id: node.id };
}

export interface AndroidToolServerOptions {
  /** Overridden in tests so the vision path runs without a network call. */
  vision?: VisionCaller;
}

export function createAndroidToolServer(
  gateway: DeviceGatewayLike,
  options: AndroidToolServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: ANDROID_TOOL_BRIDGE_NAME, version: "0.1.0" },
    {
      instructions:
        "Generic Android device control. Observe with get_screen before acting; " +
        "node ids are only valid within the snapshot that produced them. Use the " +
        "media tools for playback state and transport controls instead of UI inference.",
    },
  );

  server.registerTool(
    "get_operator_capabilities",
    {
      title: "Get operator capabilities",
      description:
        "Preflight the Android operator and report compact response budgets and available " +
        "control planes. Call once when a task needs media or notifications.",
      inputSchema: { deviceTarget: DeviceTargetSchema },
    },
    async ({ deviceTarget }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const [device, media, notifications] = await Promise.all([
        gateway.sendRequest(deviceId, { type: "get_device_state" }),
        gateway.sendRequest(deviceId, { type: "get_media_state" }),
        gateway.sendRequest(deviceId, { type: "get_notifications" }),
      ]);
      return { content: [{ type: "text", text: JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        responseBudget: { maxNodes: MAX_NODES, maxSearchResults: 20, targetTokens: 4000 },
        accessibility: device.ok === true,
        mediaSessions: media.ok === true,
        notifications: notifications.ok === true,
        device: device.result,
      }) }] };
    },
  );

  server.registerTool(
    "get_screen",
    {
      title: "Get screen",
      description:
        "Returns a compact accessibility snapshot of the current foreground screen. " +
        "Shape: {snapshotId, packageName, nodeCount, truncated, nodes:[{id, p:parentId, t:text, " +
        "d:contentDescription, f:flags(c=clickable,l=long-clickable,e=editable,s=scrollable), " +
        "b:[left,top,right,bottom]}]}. Absent fields are null. Always observe before acting.",
      inputSchema: { deviceTarget: DeviceTargetSchema },
    },
    async ({ deviceTarget }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const result = await gateway.sendRequest(deviceId, { type: "get_screen" });
      const snapshot = rememberSnapshot(deviceId, unwrap(result) as unknown as RawSnapshot);
      return {
        content: [{ type: "text", text: JSON.stringify(compactSnapshot(snapshot)) }],
      };
    },
  );

  server.registerTool(
    "find_nodes",
    {
      title: "Find screen nodes",
      description:
        "Searches the complete current accessibility tree on the bridge and returns only " +
        "matching nodes. Prefer this over requesting or scrolling through a large tree. " +
        "Results are bounded and include the snapshotId required for node actions.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        query: z.string().max(200).optional(),
        role: z.string().max(80).optional(),
        action: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      },
    },
    async ({ deviceTarget, query, role, action, limit }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const raw = rememberSnapshot(
        deviceId,
        unwrap(await gateway.sendRequest(deviceId, { type: "get_screen" })) as RawSnapshot,
      );
      const q = query?.toLowerCase();
      const r = role?.toLowerCase();
      const matches = raw.nodes.filter((node) => {
        if (q && !nodeSearchText(node).includes(q)) return false;
        if (r && !String(node.className ?? "").toLowerCase().includes(r)) return false;
        if (action && !node.actions?.includes(action)) return false;
        return true;
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            snapshotId: raw.snapshotId,
            packageName: raw.packageName,
            totalMatches: matches.length,
            returned: Math.min(matches.length, limit),
            nodes: matches.slice(0, limit).map(compactMatch),
          }),
        }],
      };
    },
  );

  server.registerTool(
    "execute_action",
    {
      title: "Execute action",
      description:
        "Executes one generic Android action. Prefer semantic node actions against the " +
        "current snapshot (click_node, set_text); use scroll/swipe/tap_coordinates only " +
        "when no node action applies; global_action covers back/home/recents/notifications; " +
        "launch_app accepts an installed package name or exact visible app label; media_control uses Android media sessions. " +
        "Consequential actions are refused here, including dismissing or invoking someone " +
        "else's notification: use commit_action for those, from a sandbox script too. " +
        "If the snapshot has been replaced since you observed it, the bridge re-observes and " +
        "re-targets the same node automatically, reporting staleSnapshotRecovery; you only see " +
        "stale_snapshot when that node is gone or ambiguous. " +
        "Returns status, screenChanged, and latency.",
      inputSchema: { deviceTarget: DeviceTargetSchema, action: DeviceActionSchema },
    },
    async ({ deviceTarget, action }) => {
      assertNotConsequential(action);
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const { result, recovery } = await executeWithStaleRecovery(gateway, deviceId, action);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(
            recovery && typeof result === "object" && result !== null
              ? { ...(result as Record<string, unknown>), staleSnapshotRecovery: recovery }
              : result,
          ),
        }],
      };
    },
  );

  server.registerTool(
    "commit_action",
    {
      title: "Commit consequential action",
      description:
        "Executes ONE consequential, externally visible Android action: sending a message, " +
        "sharing or posting content, deleting data or dismissing notifications, creating links, " +
        "or changing settings. This tool pauses for explicit human approval before executing. " +
        "Prepare everything first (recipient selected, text typed, attachment staged) using " +
        "execute_action, then call commit_action exactly once for the final commit step. " +
        "`intent` must be one plain sentence describing the real-world effect, e.g. " +
        "\"Send report.pdf to Akash on WhatsApp\" — it is shown verbatim to the user.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        intent: z.string().min(8).max(200),
        action: DeviceActionSchema,
      },
    },
    // `intent` is deliberately unused at execution time: it exists so the
    // approval surface can read clean display text off the tool-call arguments.
    async ({ deviceTarget, action }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const result = await gateway.sendRequest(deviceId, {
        type: "execute_action",
        action,
      });
      return { content: [{ type: "text", text: JSON.stringify(unwrap(result)) }] };
    },
  );

  server.registerTool(
    "execute_and_observe",
    {
      title: "Execute and observe",
      description:
        "Executes one Android action and atomically returns a bounded post-action screen " +
        "summary after the UI settles. Prefer this for navigation to reduce races and tool calls. " +
        "A node action whose snapshot has since been replaced is not simply rejected: the bridge " +
        "re-observes, re-resolves the node you named by its identity, and runs the action against " +
        "the current snapshot, reporting what it re-targeted as staleSnapshotRecovery. You get " +
        "stale_snapshot back only when that node is now missing or ambiguous, which means the " +
        "screen really did move - re-observe and replan rather than retrying the same call.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        action: DeviceActionSchema,
        settleMs: z.number().int().min(0).max(3000).default(350),
      },
    },
    async ({ deviceTarget, action, settleMs }) => {
      assertNotConsequential(action);
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const { result: actionResult, recovery } =
        await executeWithStaleRecovery(gateway, deviceId, action);
      if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
      const raw = rememberSnapshot(
        deviceId,
        unwrap(await gateway.sendRequest(deviceId, { type: "get_screen" })) as RawSnapshot,
      );
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            action: actionResult,
            ...(recovery ? { staleSnapshotRecovery: recovery } : {}),
            screen: compactSnapshot(raw),
          }),
        }],
      };
    },
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for Android state",
      description:
        "Waits without model polling until a package or node text appears. Returns a small " +
        "matching result, not repeated screen dumps.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        packageName: z.string().optional(),
        text: z.string().max(200).optional(),
        timeoutMs: z.number().int().min(100).max(15000).default(5000),
        pollMs: z.number().int().min(100).max(2000).default(300),
      },
    },
    async ({ deviceTarget, packageName, text: wantedText, timeoutMs, pollMs }) => {
      if (!packageName && !wantedText) throw new Error("packageName or text is required");
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const deadline = Date.now() + timeoutMs;
      let last: RawSnapshot | null = null;
      while (Date.now() <= deadline) {
        last = rememberSnapshot(
          deviceId,
          unwrap(await gateway.sendRequest(deviceId, { type: "get_screen" })) as RawSnapshot,
        );
        const packageOk = !packageName || last.packageName === packageName;
        const match = wantedText
          ? last.nodes.find((node) => nodeSearchText(node).includes(wantedText.toLowerCase()))
          : undefined;
        if (packageOk && (!wantedText || match)) {
          return { content: [{ type: "text", text: JSON.stringify({
            matched: true,
            snapshotId: last.snapshotId,
            packageName: last.packageName,
            node: match ? compactMatch(match) : undefined,
          }) }] };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
      return { content: [{ type: "text", text: JSON.stringify({
        matched: false,
        snapshotId: last?.snapshotId,
        packageName: last?.packageName,
        timeoutMs,
      }) }] };
    },
  );

  server.registerTool(
    "get_media_state",
    {
      title: "Get media state",
      description:
        "Returns active Android media sessions with authoritative playback state, metadata, " +
        "position, duration, and supported transport actions. Use this to verify play/pause; " +
        "do not infer playback from screenshots or timestamp nodes. If available=false, the " +
        "operator app needs notification-listener access enabled once in Android settings.",
      inputSchema: { deviceTarget: DeviceTargetSchema },
    },
    async ({ deviceTarget }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const response = await gateway.sendRequest(deviceId, { type: "get_media_state" });
      // Preserve a structured unavailable result so the model sees the exact remediation.
      const result = response.result ?? {
        available: false,
        permissionRequired: true,
        sessions: [],
        error: response.error,
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "get_notifications",
    {
      title: "Get notifications",
      description:
        "Returns a bounded summary of active Android notifications and their semantic actions. " +
        "Use notification_action through execute_action to open, dismiss, or invoke one.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        limit: z.number().int().min(1).max(30).default(15),
      },
    },
    async ({ deviceTarget, limit }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const response = await gateway.sendRequest(deviceId, { type: "get_notifications" });
      const result = response.result;
      if (!Array.isArray(result)) {
        return { content: [{ type: "text", text: JSON.stringify({
          available: false,
          permissionRequired: true,
          notifications: [],
        }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({
        available: true,
        total: result.length,
        notifications: result.slice(0, limit),
      }) }] };
    },
  );

  server.registerTool(
    "capture_screenshot",
    {
      title: "Capture screenshot",
      description:
        "Returns the current screen as an image. This puts a full frame into the calling " +
        "context and is deliberately expensive: do NOT call it on the main thread, and it is " +
        "useless from a sandbox script (a script cannot look at pixels). It exists for a " +
        "vision-recovery sub-agent in its isolated context, as a last resort. It is not an " +
        "OCR, transcription, or content-narration tool. Main agents must delegate eligible " +
        "visual work and must never call this directly. A vision-recovery sub-agent should " +
        "use inspect_screen_visually instead for both locating a target and verifying a " +
        "visual property: it returns compact grounded JSON and re-checks that the screen has " +
        "not moved around the inference, which a bare frame cannot do - a verdict judged here " +
        "may describe a screen that is already gone. Privacy-sensitive: the " +
        "image is never written to disk (it is held briefly in memory so the operator's " +
        "dashboard can show what you looked at), and secure windows are blocked by Android.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        maxDimension: z
          .number()
          .int()
          .min(256)
          .max(2048)
          .default(1024)
          .describe("Longest edge in pixels. Lower is cheaper; 1024 stays legible for UI."),
      },
    },
    async ({ deviceTarget, maxDimension }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const result = (await unwrap(
        await gateway.sendRequest(deviceId, {
          type: "capture_screenshot",
          maxDimension,
          format: "jpeg",
          quality: 75,
        }),
      )) as {
        dataBase64?: string;
        format?: string;
        width?: number;
        height?: number;
        sourceWidth?: number;
        sourceHeight?: number;
      };
      if (!result?.dataBase64) throw new Error("Screenshot unavailable on device");
      // Kept server-side as well as sent to the model: the pixels the agent
      // reasoned over are exactly what an operator needs to see afterwards,
      // and routing them through the transcript as base64 is not viable (see
      // media/frames.ts). The id is the only part that reaches the transcript.
      const frame = storeFrame({
        dataBase64: result.dataBase64,
        format: result.format,
        width: result.width,
        height: result.height,
        sourceWidth: result.sourceWidth,
        sourceHeight: result.sourceHeight,
      });
      return {
        content: [
          {
            type: "image",
            data: result.dataBase64,
            mimeType: frame.mimeType,
          } as never,
          {
            type: "text",
            // The scale factor is what makes a coordinate read off this image
            // usable: tap_coordinates works in native screen pixels.
            text: JSON.stringify({
              ...frameReference(frame),
              note: "Multiply any point read off this image by sourceWidth/width before using tap_coordinates.",
            }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "inspect_screen_visually",
    {
      title: "Inspect the screen visually",
      description:
        "Sub-agent-only visual question about the current screen, in one of two modes. " +
        "mode='locate' (default) finds an actionable control that is drawn or unlabelled and " +
        "that the accessibility tree cannot locate. mode='verify' answers whether a visual " +
        "property holds - a colour, pattern, shape, or which pictured item matches a " +
        "description - when no node field settles it. Do not use either mode to read, " +
        "transcribe, summarize, or narrate screen content. Captures the screen, shows it to a " +
        "vision model together with the current nodes and their bounds, and answers your " +
        "question. Returns {resolution, observation, ...}: 'node' with a snapshotId+nodeId you " +
        "act on normally with click_node/set_text, 'coordinates' (screen pixels, for drawn " +
        "controls with no node) for tap_coordinates, 'property' with holds=yes|no|unclear for " +
        "a verification, 'absent' with a suggestion when the subject is not on this screen, or " +
        "'unavailable' for a secure window or a screen that moved while it was being looked " +
        "at. Prefer this over capture_screenshot in both modes: it re-checks that the screen " +
        "has not changed before and after inference, so an answer can never escape a stale " +
        "frame, and no pixels enter your context. The main agent must not call this tool " +
        "directly or from Code Mode; it must delegate the visual question to a short-lived, " +
        "read-only vision-recovery sub-agent. Read-only.",
      inputSchema: {
        deviceTarget: DeviceTargetSchema,
        question: z
          .string()
          .min(1)
          .max(400)
          .describe(
            "One question: which actionable UI target must be located, or (mode='verify') " +
              "which visual property must be confirmed, on the current screen?",
          ),
        mode: z
          .enum(["locate", "verify"])
          .default("locate")
          .describe(
            "'locate' finds a UI target; 'verify' returns holds=yes|no|unclear for a visual " +
              "property. 'unclear' is a real answer, not a failure - never treat it as a yes.",
          ),
        expectation: z
          .string()
          .max(400)
          .optional()
          .describe("What you expected to be on screen, if you have a hypothesis."),
      },
    },
    async ({ deviceTarget, question, expectation, mode }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const result = await inspectScreenVisually(
        gateway,
        { deviceId, question, expectation, mode },
        {
          vision: options.vision,
          // The frame is stored but never returned to the caller as pixels:
          // the whole point of this tool is that no image enters any context.
          recordFrame: (shot) => frameReference(storeFrame(shot)),
        },
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );

  server.registerTool(
    "get_device_state",
    {
      title: "Get device state",
      description:
        "Returns lightweight device state for verification and recovery: foreground " +
        "package, orientation, accessibility service status, last snapshot id.",
      inputSchema: { deviceTarget: DeviceTargetSchema },
    },
    async ({ deviceTarget }) => {
      const deviceId = requireOnlineDevice(gateway, deviceTarget);
      const result = await gateway.sendRequest(deviceId, { type: "get_device_state" });
      return { content: [{ type: "text", text: JSON.stringify(unwrap(result)) }] };
    },
  );

  return server;
}

export interface AndroidBridgeMcpHandle {
  httpServer: Server;
  url: string;
  close(): Promise<void>;
}

/**
 * Starts the streamable-HTTP MCP endpoint. Single active transport replaced on
 * each new initialize (matches TrueForge client handshake behavior).
 */
export function startAndroidToolBridgeMcpServer(opts: {
  host: string;
  port: number;
  logRequests?: boolean;
  gateway: DeviceGatewayLike;
}): Promise<AndroidBridgeMcpHandle> {
  const app = createMcpExpressApp({ host: opts.host });
  if (opts.logRequests) {
    app.use((req, _res, next) => {
      console.log(`[bridge-mcp] ${req.method} ${req.url}`);
      next();
    });
  }

  let shared: {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  } | null = null;

  async function createPair(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = createAndroidToolServer(opts.gateway);
    await server.connect(transport);
    shared = { server, transport };
    return transport;
  }

  app.all("/mcp", (req, res) => {
    void (async () => {
      try {
        const isNewInitialize =
          req.method === "POST" &&
          req.body != null &&
          !Array.isArray(req.body) &&
          isInitializeRequest(req.body);

        if (isNewInitialize || !shared) {
          if (shared) void shared.transport.close();
          await createPair();
        }
        const pair = shared;
        if (!pair) throw new Error("no active MCP session");
        await pair.transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.error("[bridge-mcp] request error:", err);
        if (!res.headersSent) {
          res
            .status(500)
            .json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } });
        }
      }
    })();
  });

  return new Promise((resolve, reject) => {
    const httpServer = app.listen(opts.port, opts.host, () => {
      resolve({
        httpServer,
        url: `http://${opts.host}:${opts.port}/mcp`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            if (shared) void shared.transport.close();
            shared = null;
            httpServer.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
    httpServer.on("error", reject);
  });
}

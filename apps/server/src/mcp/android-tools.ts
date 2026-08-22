import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpExpressApp,
} from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

/**
 * Android Tool Bridge (handoff doc sections 10 and 11).
 *
 * MCP is the TrueForge-facing protocol; this server forwards generic device
 * primitives over the WebSocket gateway to the physical phone. The tool
 * surface is intentionally small and app agnostic.
 */

export const ANDROID_TOOL_BRIDGE_NAME = "android-tool-bridge";

const DeviceActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click_node"), nodeId: z.string() }),
  z.object({ type: z.literal("long_click_node"), nodeId: z.string() }),
  z.object({
    type: z.literal("set_text"),
    nodeId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("scroll"),
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
    action: z.enum(["back", "home", "recents", "notifications"]),
  }),
  z.object({
    type: z.literal("launch_app"),
    packageName: z.string(),
  }),
]);

export interface DeviceGatewayLike {
  listDevices(): Array<{ deviceId: string }>;
  isOnline(deviceId: string): boolean;
  sendRequest(
    deviceId: string,
    request: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

function pickOnlineDevice(gateway: DeviceGatewayLike): string {
  const online = gateway.listDevices().find((d) => gateway.isOnline(d.deviceId));
  if (!online) throw new Error("No Android device is connected to the bridge");
  return online.deviceId;
}

const MAX_TEXT_LEN = 80;
const MAX_NODES = 220;

interface RawSnapNode {
  id: string;
  parentId?: string | null;
  className?: string | null;
  text?: string | null;
  contentDescription?: string | null;
  bounds: [number, number, number, number];
  clickable?: boolean;
  longClickable?: boolean;
  editable?: boolean;
  scrollable?: boolean;
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
      if (flags) o.f = flags;
      o.b = n.bounds;
      return o;
    }),
  };
}

function unwrap(response: Record<string, unknown>): unknown {
  if (response.ok !== true) {
    const err = response.error;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err ?? response));
  }
  return response.result;
}

export function createAndroidToolServer(gateway: DeviceGatewayLike): McpServer {
  const server = new McpServer(
    { name: ANDROID_TOOL_BRIDGE_NAME, version: "0.1.0" },
    {
      instructions:
        "Generic Android device control. Observe with get_screen before acting; " +
        "node ids are only valid within the snapshot that produced them.",
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
      inputSchema: {},
    },
    async () => {
      const deviceId = pickOnlineDevice(gateway);
      const result = await gateway.sendRequest(deviceId, { type: "get_screen" });
      const snapshot = unwrap(result) as unknown as RawSnapshot;
      return {
        content: [{ type: "text", text: JSON.stringify(compactSnapshot(snapshot)) }],
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
        "launch_app opens an installed package. Returns status, screenChanged, and latency.",
      inputSchema: { action: DeviceActionSchema },
    },
    async ({ action }) => {
      const deviceId = pickOnlineDevice(gateway);
      const result = await gateway.sendRequest(deviceId, {
        type: "execute_action",
        action,
      });
      return { content: [{ type: "text", text: JSON.stringify(unwrap(result)) }] };
    },
  );

  server.registerTool(
    "capture_screenshot",
    {
      title: "Capture screenshot",
      description:
        "Captures the current screen as an image. Use only when the accessibility tree is " +
        "insufficient (visual-only content, canvas views). Privacy-sensitive: ephemeral.",
      inputSchema: {},
    },
    async () => {
      const deviceId = pickOnlineDevice(gateway);
      const result = (await unwrap(
        await gateway.sendRequest(deviceId, { type: "capture_screenshot" }),
      )) as { dataBase64?: string; width?: number; height?: number };
      if (!result?.dataBase64) throw new Error("Screenshot unavailable on device");
      return {
        content: [
          {
            type: "image",
            data: result.dataBase64,
            mimeType: "image/png",
          } as never,
          {
            type: "text",
            text: JSON.stringify({ width: result.width, height: result.height }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "get_device_state",
    {
      title: "Get device state",
      description:
        "Returns lightweight device state for verification and recovery: foreground " +
        "package, orientation, accessibility service status, last snapshot id.",
      inputSchema: {},
    },
    async () => {
      const deviceId = pickOnlineDevice(gateway);
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

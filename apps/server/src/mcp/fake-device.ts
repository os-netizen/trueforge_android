import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createMcpExpressApp,
} from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

export const FAKE_MCP_SERVER_NAME = "fake-android-device";

const FAKE_HOME_SCREEN = {
  deviceId: "fake-pixel-01",
  snapshotId: "snap_001",
  packageName: "com.android.launcher3",
  windowTitle: "Home",
  timestamp: Date.now(),
  nodes: [
    {
      id: "n1",
      parentId: null,
      className: "android.widget.FrameLayout",
      text: null,
      contentDescription: null,
      viewId: null,
      bounds: [0, 0, 1080, 2400],
      clickable: false,
      longClickable: false,
      editable: false,
      scrollable: false,
      focusable: false,
      enabled: true,
      selected: false,
      checked: null,
    },
    {
      id: "n2",
      parentId: "n1",
      className: "android.widget.TextView",
      text: "WhatsApp",
      contentDescription: "WhatsApp icon",
      viewId: null,
      bounds: [120, 1900, 360, 2140],
      clickable: true,
      longClickable: true,
      editable: false,
      scrollable: false,
      focusable: true,
      enabled: true,
      selected: false,
      checked: null,
    },
  ],
};

function createFakeDeviceServer(): McpServer {
  const server = new McpServer(
    { name: FAKE_MCP_SERVER_NAME, version: "0.1.0" },
    { instructions: "Fake Android device used to verify the TrueForge tool loop." },
  );

  server.registerTool(
    "get_test_screen",
    {
      title: "Get test screen",
      description:
        "Returns a fake accessibility snapshot of a home screen containing a WhatsApp icon.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: JSON.stringify(FAKE_HOME_SCREEN) }],
    }),
  );

  server.registerTool(
    "execute_test_action",
    {
      title: "Execute test action",
      description:
        "Executes a fake action against the fake device. Returns an action result with screenChanged.",
      inputSchema: {
        actionType: z.string().describe("The fake action type, e.g. click_node"),
        nodeId: z.string().optional().describe("Target node id when applicable"),
      },
    },
    async ({ actionType, nodeId }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            actionType,
            nodeId: nodeId ?? null,
            screenChanged: true,
            foregroundPackage: "com.whatsapp",
            latencyMs: 120,
          }),
        },
      ],
    }),
  );

  return server;
}

export interface FakeDeviceMcpHandle {
  httpServer: Server;
  url: string;
  close(): Promise<void>;
}

export interface FakeDeviceMcpOptions {
  host: string;
  port: number;
  logRequests?: boolean;
}

/**
 * Starts a streamable-HTTP MCP endpoint exposing the fake device tools.
 * Uses stateful transports (session id header) because agent harness clients
 * open the standalone GET SSE channel after initialize.
 */
export function startFakeDeviceMcpServer(
  opts: FakeDeviceMcpOptions,
): Promise<FakeDeviceMcpHandle> {
  const app = createMcpExpressApp({ host: opts.host });
  if (opts.logRequests) {
    app.use((req, _res, next) => {
      console.log(
        `[fake-mcp] ${req.method} ${req.url} host=${req.headers.host ?? "?"} sid=${String(req.headers["mcp-session-id"] ?? "-")}`,
      );
      next();
    });
  }

  /**
   * Single active server/transport pair. The agent harness client opens its
   * GET stream without echoing mcp-session-id and re-initializes per
   * connection, so strict per-session routing breaks the handshake.
   * Strategy: route every request to the current pair; when a new initialize
   * arrives, tear down the old pair and create a fresh one.
   * TODO(M4): revisit multi-session routing for the real device bridge.
   */
  let shared: {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  } | null = null;

  async function createPair(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    const server = createFakeDeviceServer();
    await server.connect(transport);
    transport.onclose = () => {
      if (shared?.transport === transport) shared = null;
    };
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
        console.error("[fake-mcp] request error:", err);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" } });
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
            httpServer.close((err) =>
              err ? rejectClose(err) : resolveClose(),
            );
          }),
      });
    });
    httpServer.on("error", reject);
  });
}

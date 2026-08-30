/**
 * TrueForge Android bridge server.
 *
 * Milestone 3: hosts the device WebSocket gateway plus small dev endpoints
 * for remote inspection/actuation (handoff doc section 37, done criterion:
 * a TypeScript caller can inspect the phone and execute an action).
 *
 *   ws://<host>:8792/device   device gateway
 *   GET  /health
 *   GET  /devices
 *   GET  /devices/{id}/screen          -> get_screen over the wire
 *   POST /devices/{id}/actions         body: DeviceAction JSON
 *   GET  /devices/{id}/state           -> get_device_state
 *   GET  /frames/{id}                  -> a captured screen, as an image
 *   GET/POST /dashboard/reasoning      -> reasoning effort, live
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { config } from "./config.js";
import { startFakeDeviceMcpServer } from "./mcp/fake-device.js";
import { startAndroidToolBridgeMcpServer } from "./mcp/android-tools.js";
import { DeviceGateway } from "./devices/gateway.js";
import {
  ActionRisk,
  classifyActionRisk,
  DeviceAction,
} from "@trueforge-android/protocol";
import {
  applyReasoningSettings,
  cancelDashboardRun,
  dashboardAnalytics,
  describeAgent,
  describeReasoning,
  findDashboardRun,
  getRunRawEvents,
  isRunLive,
  listDashboardRunsWithHistory,
  streamDashboardRun,
  streamRunTranscript,
} from "./dashboard/runs.js";
import { getFrame } from "./media/frames.js";
import { parseReasoningEffort, REASONING_EFFORTS } from "./trueforge/reasoning.js";

const PORT = Number.parseInt(process.env.DEVICE_WS_PORT ?? "8792", 10);
const DASHBOARD_DIR = fileURLToPath(
  new URL("../../dashboard/dist/client/", import.meta.url),
);

async function main(): Promise<void> {
  const gateway = new DeviceGateway();
  gateway.on("device.online", (info) => console.log(`[api] online: ${JSON.stringify(info)}`));
  gateway.on("device.offline", (id) => console.log(`[api] offline: ${id}`));

  const server = http.createServer((req, res) => {
    void handleApi(req, res, gateway).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });

  gateway.bind(server);

  await new Promise<void>((resolve) => server.listen(PORT, "0.0.0.0", resolve));
  console.log(`device gateway listening on ws://0.0.0.0:${PORT}/device`);

  // Real Android Tool Bridge: MCP endpoint backed by connected devices.
  const bridge = await startAndroidToolBridgeMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    logRequests: true,
    gateway,
  });
  console.log(`android tool bridge MCP endpoint: ${bridge.url}`);

  if (process.env.RUN_FAKE_MCP === "1") {
    const fake = await startFakeDeviceMcpServer({
      host: config.mcpHost,
      port: Number.parseInt(process.env.FAKE_MCP_PORT ?? "8811", 10),
    });
    console.log(`fake device MCP endpoint: ${fake.url}`);
  }
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  gateway: DeviceGateway,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && pathname === "/health") {
    return send(200, { ok: true });
  }

  if (req.method === "GET" && pathname === "/devices") {
    return send(200, { devices: gateway.listDevices() });
  }

  if (req.method === "GET" && (pathname === "/" || pathname.startsWith("/assets/"))) {
    return serveDashboard(pathname, req, res);
  }

  if (req.method === "GET" && pathname === "/dashboard/status") {
    return send(200, {
      ok: true,
      devices: gateway.listDevices(),
      agent: config.agentName,
      model: `${config.modelProviderName}/${config.mainModelId}`,
      bridge: `ws://0.0.0.0:${PORT}/device`,
      mcp: `http://${config.mcpHost}:${config.mcpPort}/mcp`,
      serverTime: new Date().toISOString(),
    });
  }

  if (req.method === "GET" && pathname === "/dashboard/runs") {
    return send(200, { runs: await listDashboardRunsWithHistory() });
  }

  // The agent's manifest, including the operating policy it runs under, so the
  // dashboard can show what the model was actually told.
  if (req.method === "GET" && pathname === "/dashboard/agent") {
    return send(200, describeAgent());
  }

  if (req.method === "GET" && pathname === "/dashboard/analytics") {
    return send(200, dashboardAnalytics());
  }

  // Reasoning effort, live. GET reports the current levels and the values the
  // provider accepts; POST changes either one. The agent level is a manifest
  // write, so it lands on the next turn rather than the running one.
  if (req.method === "GET" && pathname === "/dashboard/reasoning") {
    return send(200, describeReasoning());
  }

  if (req.method === "POST" && pathname === "/dashboard/reasoning") {
    let body: { agent?: unknown; vision?: unknown };
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || "{}") as typeof body;
    } catch {
      return send(400, { error: "invalid JSON body" });
    }
    const patch: { agent?: ReturnType<typeof parseReasoningEffort>; vision?: ReturnType<typeof parseReasoningEffort> } = {};
    for (const key of ["agent", "vision"] as const) {
      if (body[key] === undefined) continue;
      const parsed = parseReasoningEffort(body[key]);
      // Rejected here rather than forwarded: the provider answers an unknown
      // value with an opaque 400 in the middle of a run.
      if (!parsed) {
        return send(400, {
          error: `${key} must be one of ${REASONING_EFFORTS.join(", ")}`,
        });
      }
      patch[key] = parsed;
    }
    if (patch.agent === undefined && patch.vision === undefined) {
      return send(400, { error: "provide agent and/or vision" });
    }
    try {
      const result = await applyReasoningSettings({
        agent: patch.agent ?? undefined,
        vision: patch.vision ?? undefined,
      });
      return send(200, {
        ...result.settings,
        options: [...REASONING_EFFORTS],
        // False simply means nothing changed, so no manifest write was needed.
        agentManifestUpdated: result.applied,
      });
    } catch (err) {
      return send(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Screen frames the agent captured, served as ordinary images so the
  // transcript can carry an id instead of a few hundred KB of base64. The
  // store is in-memory and bounded, so a frame from an old run is gone - the
  // 404 is what the dashboard renders its "frame expired" placeholder from.
  const frameMatch = /^\/frames\/([^/]+)$/.exec(pathname);
  if (req.method === "GET" && frameMatch?.[1]) {
    const frame = getFrame(decodeURIComponent(frameMatch[1]).replace(/\.(jpe?g|png)$/i, ""));
    if (!frame) return send(404, { error: "frame expired or unknown" });
    res.writeHead(200, {
      "content-type": frame.mimeType,
      "content-length": frame.bytes.length,
      // Frame ids are unique per capture, so the bytes behind one never change.
      "cache-control": "private, max-age=3600, immutable",
      "x-frame-size": `${frame.width}x${frame.height}`,
      "x-frame-source-size": `${frame.sourceWidth}x${frame.sourceHeight}`,
    });
    res.end(frame.bytes);
    return;
  }

  if (req.method === "POST" && pathname === "/dashboard/runs") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let prompt = "";
    let runId: string | undefined;
    let deviceId = "";
    try {
      const parsed = JSON.parse(raw || "{}") as {
        prompt?: unknown;
        runId?: unknown;
        deviceId?: unknown;
      };
      prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
      deviceId = typeof parsed.deviceId === "string" ? parsed.deviceId.trim() : "";
      // A follow-up carries the run it continues; without it the agent would
      // start a fresh TrueForge session and lose the device context.
      runId = typeof parsed.runId === "string" && parsed.runId ? parsed.runId : undefined;
    } catch {
      return send(400, { error: "invalid JSON body" });
    }
    if (!prompt) return send(400, { error: "prompt is required" });
    if (!deviceId) return send(400, { error: "deviceId is required" });
    if (prompt.length > 4000) return send(400, { error: "prompt is too long" });
    const existingRun = runId ? findDashboardRun(runId) : undefined;
    if (runId && !existingRun) {
      return send(404, { error: "unknown run to continue" });
    }
    if (existingRun?.deviceId && existingRun.deviceId !== deviceId) {
      return send(409, {
        error: `Run '${existingRun.id}' is bound to device '${existingRun.deviceId}', not '${deviceId}'`,
      });
    }
    if (!gateway.isOnline(deviceId)) return send(409, { error: `Device '${deviceId}' is offline` });
    if (runId && isRunLive(runId)) {
      return send(409, { error: "run is still in progress" });
    }
    return streamDashboardRun(prompt, res, gateway, { runId, deviceId });
  }

  // Transcript for one run: replayed live for an in-flight run, rebuilt from
  // TrueForge's persisted events for a finished one.
  const transcriptMatch = /^\/dashboard\/runs\/([^/]+)\/transcript$/.exec(pathname);
  if (req.method === "GET" && transcriptMatch?.[1]) {
    return streamRunTranscript(decodeURIComponent(transcriptMatch[1]), res);
  }

  const rawEventsMatch = /^\/dashboard\/runs\/([^/]+)\/events$/.exec(pathname);
  if (req.method === "GET" && rawEventsMatch?.[1]) {
    try {
      const result = await getRunRawEvents(decodeURIComponent(rawEventsMatch[1]));
      return send(200, result);
    } catch (err) {
      return send(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Phone-initiated runs need a Stop control; cancelling the TrueForge session
  // ends the in-flight NDJSON stream with run.failed "cancelled by user".
  const cancelMatch = /^\/dashboard\/runs\/([^/]+)\/cancel$/.exec(pathname);
  if (req.method === "POST" && cancelMatch?.[1]) {
    const runId = decodeURIComponent(cancelMatch[1]);
    try {
      const cancelled = await cancelDashboardRun(runId);
      return cancelled
        ? send(200, { ok: true })
        : send(404, { error: "unknown or finished run" });
    } catch (err) {
      return send(502, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const match = /^\/devices\/([^/]+)(\/screen|\/screenshot|\/state|\/media|\/notifications|\/actions)?$/.exec(pathname);
  if (!match || !match[1]) return send(404, { error: "not found" });

  const deviceId = decodeURIComponent(match[1]);
  const route = match[2] ?? "";

  if (route === "" && req.method === "GET") {
    const info = gateway.listDevices().find((d) => d.deviceId === deviceId);
    return info ? send(200, info) : send(404, { error: "unknown or offline device" });
  }

  try {
    if (route === "/screen" && req.method === "GET") {
      const response = await gateway.sendRequest(deviceId, { type: "get_screen" });
      return send(200, response);
    }
    if (route === "/state" && req.method === "GET") {
      const response = await gateway.sendRequest(deviceId, { type: "get_device_state" });
      return send(200, response);
    }
    if (route === "/media" && req.method === "GET") {
      const response = await gateway.sendRequest(deviceId, { type: "get_media_state" });
      return send(200, response);
    }
    if (route === "/notifications" && req.method === "GET") {
      const response = await gateway.sendRequest(deviceId, { type: "get_notifications" });
      return send(200, response);
    }
    if (route === "/screenshot" && req.method === "GET") {
      const response = await gateway.sendRequest(deviceId, { type: "capture_screenshot" });
      return send(200, response);
    }
    if (route === "/actions" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const parsed = DeviceAction.safeParse(JSON.parse(raw || "{}"));
      if (!parsed.success) {
        return send(400, { error: "invalid action", issues: parsed.error.issues });
      }
      // Direct operator/debug actuation: risk is recorded for the log only.
      // Agent-driven consequential steps go through commit_action, which the
      // agent manifest gates via requireApprovalForTools.
      const risk: ActionRisk = classifyActionRisk(parsed.data);
      console.log(`[api] action requested risk=${risk}:`, JSON.stringify(parsed.data));
      const response = await gateway.sendRequest(deviceId, {
        type: "execute_action",
        action: parsed.data,
      });
      return send(200, response);
    }
  } catch (err) {
    return send(502, { error: err instanceof Error ? err.message : String(err) });
  }

  return send(404, { error: "not found" });
}

async function serveDashboard(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^\/+/, "");
  const filePath = join(DASHBOARD_DIR, relative);
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    const contentTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".png": "image/png",
      ".svg": "image/svg+xml",
    };
    const acceptsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] ?? "");
    const compressible = [".html", ".js", ".css", ".svg"].includes(extname(filePath));
    const encoded = acceptsGzip && compressible ? gzipSync(body, { level: 6 }) : body;
    console.log(`[dashboard] ${pathname} ${body.length}B -> ${encoded.length}B`);
    res.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": relative === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      ...(encoded !== body ? { "content-encoding": "gzip", vary: "accept-encoding" } : {}),
    });
    res.end(encoded);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

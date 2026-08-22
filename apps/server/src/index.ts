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
 */
import http from "node:http";
import { config } from "./config.js";
import { startFakeDeviceMcpServer } from "./mcp/fake-device.js";
import { startAndroidToolBridgeMcpServer } from "./mcp/android-tools.js";
import { DeviceGateway } from "./devices/gateway.js";
import {
  ActionRisk,
  classifyActionRisk,
  DeviceAction,
} from "@trueforge-android/protocol";

const PORT = Number.parseInt(process.env.DEVICE_WS_PORT ?? "8792", 10);

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
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "GET" && url.pathname === "/health") {
    return send(200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/devices") {
    return send(200, { devices: gateway.listDevices() });
  }

  const match = /^\/devices\/([^/]+)(\/screen|\/state|\/actions)?$/.exec(url.pathname);
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
    if (route === "/actions" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const parsed = DeviceAction.safeParse(JSON.parse(raw || "{}"));
      if (!parsed.success) {
        return send(400, { error: "invalid action", issues: parsed.error.issues });
      }
      // Safety note (doc section 22): risk classification is recorded now;
      // approval gating lands in Milestone 6.
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

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

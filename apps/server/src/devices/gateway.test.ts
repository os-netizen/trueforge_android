import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@trueforge-android/protocol";
import { DeviceGateway } from "./gateway.js";

const DEVICE_ID = "test-device";

/** Spins up a gateway with one connected fake device. */
async function withDevice(
  body: (context: { gateway: DeviceGateway; socket: WebSocket }) => Promise<void>,
): Promise<void> {
  const gateway = new DeviceGateway();
  const server = http.createServer();
  gateway.bind(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/device`);

  try {
    await new Promise<void>((resolve, reject) => {
      gateway.once("device.online", () => resolve());
      socket.once("error", reject);
      socket.once("open", () => socket.send(JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        deviceId: DEVICE_ID,
        model: "fake",
        androidVersion: "14",
        accessibilityServiceEnabled: true,
      })));
    });
    await body({ gateway, socket });
  } finally {
    socket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("sendRequest honors a per-call timeout override", async () => {
  await withDevice(async ({ gateway }) => {
    const started = Date.now();
    // The device deliberately never answers; the default budget is 15s, so
    // rejecting quickly can only come from the override.
    await assert.rejects(
      gateway.sendRequest(DEVICE_ID, { type: "get_screen" }, { timeoutMs: 60 }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 5_000, "override did not shorten the wait");
  });
});

test("an approval can outlive the default request budget", async () => {
  await withDevice(async ({ gateway, socket }) => {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { type: string; requestId: string };
      if (request.type !== "request_approval") return;
      socket.send(JSON.stringify({
        type: "request_approval",
        requestId: request.requestId,
        ok: true,
        result: { decision: "allow", reason: null },
        error: null,
      }));
    });

    const response = await gateway.sendRequest(
      DEVICE_ID,
      {
        type: "request_approval",
        toolCallId: "call-1",
        intent: "Dismiss the EVAL-APPROVAL target notification",
        actionJson: "{}",
        timeoutMs: 120_000,
      },
      { timeoutMs: 125_000 },
    );

    assert.equal(response.type, "request_approval");
    assert.equal(response.ok, true);
    assert.deepEqual(
      response.type === "request_approval" ? response.result : null,
      { decision: "allow", reason: null },
    );
  });
});

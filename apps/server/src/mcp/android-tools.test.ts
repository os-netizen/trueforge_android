import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  clearSnapshotCache,
  compactSnapshot,
  createAndroidToolServer,
  type DeviceGatewayLike,
} from "./android-tools.js";
import { createDeviceTarget } from "../devices/target.js";

const TABLET_TARGET = createDeviceTarget("tablet-1");

interface RecordedRequest {
  deviceId: string;
  request: Record<string, unknown>;
  opts?: { timeoutMs?: number };
}

function fakeGateway(result: unknown): {
  gateway: DeviceGatewayLike;
  sent: RecordedRequest[];
} {
  const sent: RecordedRequest[] = [];
  return {
    sent,
    gateway: {
      listDevices: () => [{ deviceId: "tablet-1" }],
      isOnline: () => true,
      sendRequest: async (deviceId, request, opts) => {
        sent.push({ deviceId, request, opts });
        return { ok: true, result };
      },
    },
  };
}

async function connectedClient(gateway: DeviceGatewayLike): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    createAndroidToolServer(gateway).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

test("commit_action is registered as the gated commit surface", async () => {
  const { gateway } = fakeGateway({ status: "success" });
  const client = await connectedClient(gateway);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("commit_action"), `tools=${names.join(",")}`);
  await client.close();
});

test("a tool call routes to its explicit device instead of the first connected device", async () => {
  const sent: RecordedRequest[] = [];
  const gateway: DeviceGatewayLike = {
    listDevices: () => [{ deviceId: "tablet-1" }, { deviceId: "nord-1" }],
    isOnline: () => true,
    sendRequest: async (deviceId, request, opts) => {
      sent.push({ deviceId, request, opts });
      return { ok: true, result: { foregroundPackage: "example" } };
    },
  };
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "get_device_state",
    arguments: { deviceTarget: createDeviceTarget("nord-1") },
  });

  assert.notEqual(result.isError, true);
  assert.equal(sent[0]?.deviceId, "nord-1");
  await client.close();
});

test("a tool call refuses an unknown device instead of falling back", async () => {
  const { gateway, sent } = fakeGateway({ foregroundPackage: "example" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "get_device_state",
    arguments: { deviceTarget: createDeviceTarget("nord-unknown") },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(sent, []);
  await client.close();
});

test("a tool call refuses a forged device target before gateway dispatch", async () => {
  const { gateway, sent } = fakeGateway({ foregroundPackage: "example" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "get_device_state",
    arguments: { deviceTarget: `${TABLET_TARGET.slice(0, -1)}x` },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(sent, []);
  await client.close();
});

test("commit_action forwards an execute_action to the device and unwraps the result", async () => {
  const { gateway, sent } = fakeGateway({ status: "success", screenChanged: true });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "commit_action",
    arguments: {
      deviceTarget: TABLET_TARGET,
      intent: "Dismiss the EVAL-APPROVAL target notification",
      action: { type: "notification_action", key: "0|com.android.shell|1|evalTag|2000", action: "dismiss" },
    },
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.deviceId, "tablet-1");
  assert.deepEqual(sent[0]?.request, {
    type: "execute_action",
    action: {
      type: "notification_action",
      key: "0|com.android.shell|1|evalTag|2000",
      action: "dismiss",
    },
  });
  assert.deepEqual(JSON.parse(textOf(result)), { status: "success", screenChanged: true });
  await client.close();
});

test("commit_action rejects an intent too short to display", async () => {
  const { gateway, sent } = fakeGateway({ status: "success" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "commit_action",
    arguments: {
      deviceTarget: TABLET_TARGET,
      intent: "send",
      action: { type: "global_action", action: "back" },
    },
  });

  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(sent.length, 0, "a rejected intent must not reach the device");
  await client.close();
});

test("screen summaries stay bounded below TrueForge's large-result threshold", () => {
  const nodes = Array.from({ length: 500 }, (_, index) => ({
    id: `n${index}`,
    parentId: index === 0 ? null : `n${index - 1}`,
    className: "android.widget.Button",
    viewId: `com.example:id/action_${index}`,
    text: "A deliberately long node label used to exercise response size bounding ".repeat(3),
    contentDescription: "A deliberately long accessibility description ".repeat(3),
    bounds: [0, index, 1200, index + 40] as [number, number, number, number],
    clickable: true,
    longClickable: false,
    editable: false,
    scrollable: false,
    enabled: true,
    selected: false,
    checked: null,
    actions: ["click"],
    range: null,
  }));
  const compact = compactSnapshot({
    deviceId: "device",
    snapshotId: "snap_1",
    packageName: "com.example",
    timestamp: Date.now(),
    nodes,
  });
  const encoded = JSON.stringify(compact);
  assert.equal((compact.nodes as unknown[]).length, 60);
  assert.equal(compact.truncated, true);
  // TrueForge offloads an individual MCP result at ~6k tokens. Staying under
  // 20k characters gives margin for tokenizer variance and response framing.
  assert.ok(encoded.length < 20_000, `compact response was ${encoded.length} characters`);
});

test("execute_action refuses a consequential notification dismissal", async () => {
  const { gateway, sent } = fakeGateway({ status: "ok" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "execute_action",
    arguments: { deviceTarget: TABLET_TARGET, action: { type: "notification_action", key: "k1", action: "dismiss" } },
  });

  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /commit_action/);
  // The gate is only real if nothing reached the device.
  assert.deepEqual(sent, []);
});

test("execute_and_observe refuses a consequential notification action", async () => {
  const { gateway, sent } = fakeGateway({ status: "ok" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "execute_and_observe",
    arguments: { deviceTarget: TABLET_TARGET, action: { type: "notification_action", key: "k1", action: "invoke" } },
  });

  assert.equal(result.isError, true);
  assert.deepEqual(sent, []);
});

test("opening a notification stays on the ungated path", async () => {
  const { gateway, sent } = fakeGateway({ status: "ok" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "execute_action",
    arguments: { deviceTarget: TABLET_TARGET, action: { type: "notification_action", key: "k1", action: "open" } },
  });

  assert.notEqual(result.isError, true);
  assert.equal(sent.length, 1);
});

test("commit_action still performs the dismissal the ungated tools refuse", async () => {
  const { gateway, sent } = fakeGateway({ status: "ok" });
  const client = await connectedClient(gateway);
  const result = await client.callTool({
    name: "commit_action",
    arguments: {
      deviceTarget: TABLET_TARGET,
      intent: "Dismiss the EVAL-JUNK notification",
      action: { type: "notification_action", key: "k1", action: "dismiss" },
    },
  });

  assert.notEqual(result.isError, true);
  assert.equal(sent.length, 1);
});

/**
 * The Amazon runs lost iterations to this exact cycle: observe, search (which
 * silently replaces the device's live snapshot), act on the older id, get
 * stale_snapshot, re-observe, retry. The bridge now closes it itself.
 */
function stalingGateway(snapshots: Array<Record<string, unknown>>): {
  gateway: DeviceGatewayLike;
  sent: RecordedRequest[];
} {
  const sent: RecordedRequest[] = [];
  // The cache is process-wide; each scenario reuses snapshot ids.
  clearSnapshotCache();
  let observed = -1;
  return {
    sent,
    gateway: {
      listDevices: () => [{ deviceId: "tablet-1" }],
      isOnline: () => true,
      sendRequest: async (deviceId, request, opts) => {
        sent.push({ deviceId, request, opts });
        if (request.type === "get_screen") {
          observed = Math.min(observed + 1, snapshots.length - 1);
          return { ok: true, result: snapshots[observed] };
        }
        const action = request.action as { snapshotId?: string };
        const live = snapshots[observed] as { snapshotId?: string } | undefined;
        if (action?.snapshotId !== undefined && action.snapshotId !== live?.snapshotId) {
          return { ok: true, result: { status: "stale_snapshot", screenChanged: false } };
        }
        return { ok: true, result: { status: "success", screenChanged: true } };
      },
    },
  };
}

function snapshot(id: string, nodes: Array<Record<string, unknown>>): Record<string, unknown> {
  return { deviceId: "tablet-1", snapshotId: id, packageName: "com.shop", timestamp: 0, nodes };
}

const CART_BUTTON = { className: "android.widget.Button", viewId: "add_to_cart", text: "Add to cart", contentDescription: null, bounds: [0, 100, 200, 160] };
const BANNER = { className: "android.widget.TextView", viewId: "banner", text: "Sponsored", contentDescription: null, bounds: [0, 0, 200, 80] };

test("a node action re-targets itself when the snapshot was replaced", async () => {
  // n2 in snap_1 is the cart button; after the refresh it is n1, so replaying
  // the raw id would have pressed the banner instead.
  const { gateway, sent } = stalingGateway([
    snapshot("snap_1", [{ id: "n1", ...BANNER }, { id: "n2", ...CART_BUTTON }]),
    snapshot("snap_2", [{ id: "n1", ...CART_BUTTON }, { id: "n2", ...BANNER }]),
  ]);
  const client = await connectedClient(gateway);
  await client.callTool({ name: "get_screen", arguments: { deviceTarget: TABLET_TARGET } });
  // find_nodes takes a second observation, invalidating snap_1 on the device.
  await client.callTool({ name: "find_nodes", arguments: { deviceTarget: TABLET_TARGET, query: "cart" } });

  const result = await client.callTool({
    name: "execute_action",
    arguments: {
      deviceTarget: TABLET_TARGET,
      action: { type: "click_node", snapshotId: "snap_1", nodeId: "n2" },
    },
  });

  const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
  assert.equal(payload.status, "success");
  assert.deepEqual(payload.staleSnapshotRecovery, {
    fromSnapshotId: "snap_1",
    toSnapshotId: "snap_2",
    fromNodeId: "n2",
    toNodeId: "n1",
  });
  const clicks = sent.filter((s) => s.request.type === "execute_action");
  assert.equal(clicks.length, 2);
  assert.deepEqual(clicks[1]?.request.action, {
    type: "click_node",
    snapshotId: "snap_2",
    nodeId: "n1",
  });
});

test("a vanished node still reports stale_snapshot rather than acting on a guess", async () => {
  const { gateway } = stalingGateway([
    snapshot("snap_1", [{ id: "n1", ...BANNER }, { id: "n2", ...CART_BUTTON }]),
    snapshot("snap_2", [{ id: "n1", ...BANNER }]),
  ]);
  const client = await connectedClient(gateway);
  await client.callTool({ name: "get_screen", arguments: { deviceTarget: TABLET_TARGET } });
  await client.callTool({ name: "find_nodes", arguments: { deviceTarget: TABLET_TARGET, query: "cart" } });

  const result = await client.callTool({
    name: "execute_and_observe",
    arguments: {
      deviceTarget: TABLET_TARGET,
      action: { type: "click_node", snapshotId: "snap_1", nodeId: "n2" },
      settleMs: 0,
    },
  });

  const payload = JSON.parse(textOf(result)) as { action: { status: string }; staleSnapshotRecovery?: unknown };
  assert.equal(payload.action.status, "stale_snapshot");
  assert.equal(payload.staleSnapshotRecovery, undefined);
});

test("an ambiguous identity is not re-targeted", async () => {
  const { gateway } = stalingGateway([
    snapshot("snap_1", [{ id: "n1", ...CART_BUTTON }]),
    snapshot("snap_2", [{ id: "n1", ...CART_BUTTON }, { id: "n2", ...CART_BUTTON }]),
  ]);
  const client = await connectedClient(gateway);
  await client.callTool({ name: "get_screen", arguments: { deviceTarget: TABLET_TARGET } });
  await client.callTool({ name: "find_nodes", arguments: { deviceTarget: TABLET_TARGET, query: "cart" } });

  const result = await client.callTool({
    name: "execute_action",
    arguments: {
      deviceTarget: TABLET_TARGET,
      action: { type: "click_node", snapshotId: "snap_1", nodeId: "n1" },
    },
  });

  const payload = JSON.parse(textOf(result)) as Record<string, unknown>;
  assert.equal(payload.status, "stale_snapshot");
  assert.equal(payload.staleSnapshotRecovery, undefined);
});

test("a scroll with no node only needs the current snapshot id", async () => {
  const { gateway, sent } = stalingGateway([
    snapshot("snap_1", [{ id: "n1", ...BANNER }]),
    snapshot("snap_2", [{ id: "n1", ...BANNER }]),
  ]);
  const client = await connectedClient(gateway);
  await client.callTool({ name: "get_screen", arguments: { deviceTarget: TABLET_TARGET } });
  await client.callTool({ name: "find_nodes", arguments: { deviceTarget: TABLET_TARGET } });

  const result = await client.callTool({
    name: "execute_action",
    arguments: {
      deviceTarget: TABLET_TARGET,
      action: { type: "scroll", snapshotId: "snap_1", direction: "down" },
    },
  });

  assert.equal((JSON.parse(textOf(result)) as { status: string }).status, "success");
  const scrolls = sent.filter((s) => s.request.type === "execute_action");
  assert.equal((scrolls[1]?.request.action as { snapshotId: string }).snapshotId, "snap_2");
});

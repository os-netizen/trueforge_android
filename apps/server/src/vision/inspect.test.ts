import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectScreenVisually,
  retargetToActionable,
  parseVisionJson,
  selectCandidates,
  type VisionGatewayLike,
} from "./inspect.js";
import type { VisionRequest } from "./client.js";

interface Node {
  id: string;
  bounds: [number, number, number, number];
  text?: string;
  contentDescription?: string;
  className?: string;
  clickable?: boolean;
}

const NODES: Node[] = [
  { id: "n1", bounds: [0, 0, 1200, 2000], className: "android.widget.FrameLayout" },
  { id: "n2", bounds: [40, 100, 400, 180], text: "Mute", clickable: true, className: "android.widget.Button" },
  { id: "n3", bounds: [40, 300, 400, 380], text: "Speaker", clickable: true, className: "android.widget.Button" },
  { id: "n4", bounds: [40, 500, 900, 560], text: "Call in progress", className: "android.widget.TextView" },
];

/** 1200x2000 screen delivered as a 600x1000 JPEG: every mapping is scaled by 2. */
function gatewayWith(shot: Record<string, unknown> | null, ok = true): {
  gateway: VisionGatewayLike;
  sent: Array<Record<string, unknown>>;
} {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    gateway: {
      listDevices: () => [{ deviceId: "tablet-1" }],
      isOnline: () => true,
      sendRequest: async (_deviceId, request) => {
        sent.push(request);
        if (request.type === "get_screen") {
          return {
            ok: true,
            result: {
              snapshotId: "snap-1",
              packageName: "com.example.dialer",
              windowTitle: "Call",
              nodes: NODES,
            },
          };
        }
        return ok ? { ok: true, result: shot } : { ok: false, error: "screenshot unavailable" };
      },
    },
  };
}

const SHOT = {
  format: "jpeg",
  dataBase64: "AAAA",
  width: 600,
  height: 1000,
  sourceWidth: 1200,
  sourceHeight: 2000,
};

function caller(response: string): { fn: (r: VisionRequest) => Promise<string>; seen: VisionRequest[] } {
  const seen: VisionRequest[] = [];
  return {
    seen,
    fn: async (r) => {
      seen.push(r);
      return response;
    },
  };
}

test("re-binds a visual target to an accessibility node", async () => {
  const { gateway } = gatewayWith(SHOT);
  const vision = caller('{"resolution":"node","nodeId":"n2","confidence":"high","observation":"The mute toggle is the leftmost button."}');
  const result = await inspectScreenVisually(gateway, { question: "which control mutes?" }, { vision: vision.fn });

  assert.equal(result.resolution, "node");
  assert.partialDeepStrictEqual(result, { snapshotId: "snap-1", nodeId: "n2", confidence: "high" });
});

test("sends node bounds in the downsampled image's pixel space", async () => {
  const { gateway } = gatewayWith(SHOT);
  const vision = caller('{"resolution":"node","nodeId":"n2","observation":"x"}');
  await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  const prompt = vision.seen[0]?.prompt ?? "";
  // n2's native bounds [40,100,400,180] halve at a 600/1200 scale.
  assert.match(prompt, /n2\t\[20,50,200,90\]/);
  assert.match(prompt, /600x1000 pixels/);
});

test("requests a downsampled jpeg rather than a native-resolution frame", async () => {
  const { gateway, sent } = gatewayWith(SHOT);
  await inspectScreenVisually(gateway, { question: "q" }, { vision: caller('{"resolution":"absent","observation":"x","suggestion":"y"}').fn });

  const capture = sent.find((r) => r.type === "capture_screenshot");
  assert.partialDeepStrictEqual(capture, { maxDimension: 1024, format: "jpeg" });
});

test("maps coordinates back into native screen space", async () => {
  const { gateway } = gatewayWith(SHOT);
  const vision = caller('{"resolution":"coordinates","x":100,"y":250,"confidence":"medium","observation":"A drawn slider."}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.partialDeepStrictEqual(result, { resolution: "coordinates", x: 200, y: 500 });
});

test("rejects coordinates outside the frame instead of tapping its edge", async () => {
  const { gateway } = gatewayWith(SHOT);
  const vision = caller('{"resolution":"coordinates","x":99999,"y":-40,"observation":"x"}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.equal(result.resolution, "absent");
  assert.match((result as { suggestion: string }).suggestion, /outside the 600x1000 frame/);
});

test("absorbs rounding slop at the frame edge", async () => {
  const { gateway } = gatewayWith(SHOT);
  const vision = caller('{"resolution":"coordinates","x":603,"y":-2,"observation":"x"}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  // Scaled to native and clamped to the display; -0 must not survive.
  assert.partialDeepStrictEqual(result, { resolution: "coordinates", x: 1199, y: 0 });
  assert.ok(!Object.is((result as { y: number }).y, -0));
});

test("uses a separate scale per axis when the device truncates them differently", async () => {
  // 1000x1499 native downsampled to 501x750: x ratio 1.996, y ratio 1.9987.
  const { gateway } = gatewayWith({
    format: "jpeg",
    dataBase64: "AAAA",
    width: 501,
    height: 750,
    sourceWidth: 1000,
    sourceHeight: 1499,
  });
  const vision = caller('{"resolution":"coordinates","x":500,"y":749,"observation":"x"}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  // A single shared X ratio would put y at 998, not 1497.
  assert.partialDeepStrictEqual(result, { resolution: "coordinates", x: 998, y: 1497 });
});

test("refuses to answer when the screen moved mid-capture", async () => {
  let screens = 0;
  const gateway = {
    listDevices: () => [{ deviceId: "tablet-1" }],
    isOnline: () => true,
    sendRequest: async (_deviceId: string, request: Record<string, unknown>) => {
      if (request.type === "get_screen") {
        screens += 1;
        return {
          ok: true,
          result: {
            snapshotId: `snap-${screens}`,
            // The second read lands after the user has switched apps.
            packageName: screens === 1 ? "com.example.dialer" : "com.example.launcher",
            windowTitle: "Call",
            nodes: NODES,
          },
        };
      }
      return { ok: true, result: SHOT };
    },
  };
  const vision = caller('{"resolution":"coordinates","x":10,"y":10,"observation":"x"}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.equal(result.resolution, "unavailable");
  assert.match(result.observation, /changed while it was being inspected/);
  // The model call is skipped entirely: a moved screen must cost no tokens.
  assert.equal(vision.seen.length, 0);
});

test("refuses a vision answer when the screen changes during inference", async () => {
  let screens = 0;
  const gateway: VisionGatewayLike = {
    listDevices: () => [{ deviceId: "tablet-1" }],
    isOnline: () => true,
    sendRequest: async (_deviceId, request) => {
      if (request.type === "get_screen") {
        screens += 1;
        return {
          ok: true,
          result: {
            snapshotId: `snap-${screens}`,
            packageName: "com.example.dialer",
            windowTitle: "Call",
            nodes: screens < 3
              ? NODES
              : NODES.map((node) => node.id === "n2" ? { ...node, text: "Unmute" } : node),
          },
        };
      }
      return { ok: true, result: SHOT };
    },
  };
  const vision = caller('{"resolution":"node","nodeId":"n2","observation":"Mute"}');

  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.equal(result.resolution, "unavailable");
  assert.match(result.observation, /changed while vision was analyzing/);
  assert.equal(vision.seen.length, 1);
});

test("keeps interactable nodes when small labels would crowd them out", () => {
  const labels: Node[] = Array.from({ length: 80 }, (_, i) => ({
    id: `label-${i}`,
    bounds: [0, i, 4, i + 4],
    text: `t${i}`,
    className: "android.widget.TextView",
  }));
  const target: Node = {
    id: "target",
    bounds: [0, 0, 500, 500],
    text: "Send",
    clickable: true,
    className: "android.widget.Button",
  };
  const chosen = selectCandidates([...labels, target]);

  // Every label is smaller than the button, so a single global sort by area
  // would drop the only actionable node and force a coordinate answer.
  assert.ok(chosen.some((n) => n.id === "target"));
  assert.equal(chosen[0]?.id, "target");
});

test("downgrades a hallucinated node id to absent instead of a doomed action", async () => {
  const { gateway } = gatewayWith(SHOT);
  const vision = caller('{"resolution":"node","nodeId":"n999","observation":"I see a mute button."}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.equal(result.resolution, "absent");
  assert.match((result as { suggestion: string }).suggestion, /n999/);
});

test("reports a blocked capture as unavailable rather than throwing", async () => {
  const { gateway } = gatewayWith(null, false);
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: caller("{}").fn });

  assert.equal(result.resolution, "unavailable");
  assert.match(result.observation, /FLAG_SECURE/);
});

test("treats a frame with no source dimensions as unscaled", async () => {
  const { gateway } = gatewayWith({ format: "png", dataBase64: "AAAA", width: 1200, height: 2000 });
  const vision = caller('{"resolution":"coordinates","x":300,"y":400,"observation":"x"}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.partialDeepStrictEqual(result, { x: 300, y: 400 });
});

test("falls back to unscaled when only one source dimension arrives", async () => {
  // Half a pair is worse than none: honouring it would skew one axis only.
  const { gateway } = gatewayWith({
    format: "jpeg",
    dataBase64: "AAAA",
    width: 600,
    height: 1000,
    sourceWidth: 1200,
  });
  const vision = caller('{"resolution":"coordinates","x":300,"y":400,"observation":"x"}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.partialDeepStrictEqual(result, { x: 300, y: 400 });
});

test("offers the smallest candidates first so a full-screen container never wins", () => {
  const ordered = selectCandidates(NODES);
  assert.equal(ordered[0]?.id, "n2");
  assert.ok(ordered.findIndex((n) => n.id === "n4") > ordered.findIndex((n) => n.id === "n3"));
});

test("parses JSON out of a fenced or chatty reply", () => {
  assert.deepEqual(parseVisionJson('```json\n{"resolution":"absent"}\n```'), { resolution: "absent" });
  assert.deepEqual(parseVisionJson('Sure! {"resolution":"absent"} hope that helps'), {
    resolution: "absent",
  });
  assert.throws(() => parseVisionJson("no json here"), /did not return JSON/);
});


test("retargets a label node to its clickable parent", () => {
  const container = { id: "n14", bounds: [231, 333, 357, 405] as [number, number, number, number], clickable: true };
  const labelNode = { id: "n15", parentId: "n14", bounds: [267, 352, 321, 386] as [number, number, number, number], text: "Send" };
  assert.equal(retargetToActionable(labelNode, [container, labelNode]).id, "n14");
});

test("retargets by geometry when the tree carries no parent link", () => {
  const container = { id: "outer", bounds: [0, 0, 400, 400] as [number, number, number, number], clickable: true };
  const tight = { id: "tight", bounds: [200, 300, 360, 400] as [number, number, number, number], clickable: true };
  const labelNode = { id: "lbl", bounds: [267, 352, 321, 386] as [number, number, number, number], text: "Send" };
  // Tightest enclosing target wins, not the full-screen container.
  assert.equal(retargetToActionable(labelNode, [container, tight, labelNode]).id, "tight");
});

test("leaves an already-clickable node alone", () => {
  const button = { id: "b", bounds: [0, 0, 10, 10] as [number, number, number, number], clickable: true, text: "Send" };
  assert.equal(retargetToActionable(button, [button]).id, "b");
});

test("reports the retarget in the observation so the operator can see it happened", async () => {
  const nodes = [
    { id: "n14", bounds: [231, 333, 357, 405], clickable: true, className: "android.widget.Button" },
    { id: "n15", parentId: "n14", bounds: [267, 352, 321, 386], text: "Send", className: "android.widget.TextView" },
  ];
  const gateway = {
    listDevices: () => [{ deviceId: "t" }],
    isOnline: () => true,
    sendRequest: async (_d: string, request: Record<string, unknown>) =>
      request.type === "get_screen"
        ? { ok: true, result: { snapshotId: "s1", packageName: "p", windowTitle: null, nodes } }
        : { ok: true, result: SHOT },
  };
  const vision = caller('{"resolution":"node","nodeId":"n15","confidence":"high","observation":"The Send button."}');
  const result = await inspectScreenVisually(gateway, { question: "q" }, { vision: vision.fn });

  assert.partialDeepStrictEqual(result, { resolution: "node", nodeId: "n14" });
  assert.match((result as { observation: string }).observation, /Resolved .* to its clickable container n14/);
});

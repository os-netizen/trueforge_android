import { callVisionModel, type VisionCaller } from "./client.js";

/**
 * Visual screen inspection (handoff doc sections 20 and 21).
 *
 * The point of this module is *not* to return a tap coordinate. Coordinates
 * are the weakest possible answer: they bypass the snapshot discipline every
 * other tool enforces, they go stale the moment anything reflows, and they
 * tell the operator nothing about what it is touching. So the screenshot is
 * sent to the vision model together with the accessibility nodes and their
 * bounds, and the model's primary job is re-binding - naming which existing
 * node is the thing the operator could not find by label. Coordinates are the
 * fallback for genuinely unlabelled pixels (canvas, custom-drawn controls),
 * and "absent" is a first-class answer so a stuck operator learns to replan
 * instead of tapping hopefully.
 */

/** Longest edge sent to the model. Legible for UI, small enough to stay cheap. */
const IMAGE_MAX_DIMENSION = 1024;
const IMAGE_QUALITY = 75;
/** Nodes offered as re-binding candidates. Bounded like every other response. */
const MAX_CANDIDATES = 45;
const MAX_LABEL_LEN = 60;
/** Rounding slop absorbed at the frame edge before an answer is rejected. */
const COORD_TOLERANCE_PX = 8;

export interface VisionGatewayLike {
  listDevices(): Array<{ deviceId: string }>;
  isOnline(deviceId: string): boolean;
  sendRequest(
    deviceId: string,
    request: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

export interface InspectRequest {
  deviceId?: string;
  /** What the operator needs to know, e.g. "which control mutes the call?". */
  question: string;
  /** What the operator expected to be there, if it has a hypothesis. */
  expectation?: string;
}

export type VisionResolution =
  | {
      resolution: "node";
      snapshotId: string;
      nodeId: string;
      confidence: Confidence;
      observation: string;
      screen: ScreenRef;
    }
  | {
      resolution: "coordinates";
      snapshotId: string;
      x: number;
      y: number;
      confidence: Confidence;
      observation: string;
      screen: ScreenRef;
    }
  | {
      resolution: "absent";
      observation: string;
      suggestion: string;
      screen: ScreenRef;
    }
  | { resolution: "unavailable"; observation: string };

type Confidence = "high" | "medium" | "low";

interface ScreenRef {
  packageName: string;
  windowTitle: string | null;
}

interface SnapNode {
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
}

interface Snapshot {
  snapshotId: string;
  packageName: string;
  windowTitle?: string | null;
  nodes: SnapNode[];
}

interface Screenshot {
  format: string;
  dataBase64: string;
  width: number;
  height: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

function screenSignature(snapshot: Snapshot): string {
  return JSON.stringify({
    packageName: snapshot.packageName,
    windowTitle: snapshot.windowTitle ?? null,
    nodes: snapshot.nodes,
  });
}

function unwrap(response: Record<string, unknown>): unknown {
  if (response.ok !== true) {
    const err = response.error;
    throw new Error(typeof err === "string" ? err : JSON.stringify(err ?? response));
  }
  return response.result;
}

function label(node: SnapNode): string {
  const parts = [node.text, node.contentDescription].filter(
    (v): v is string => typeof v === "string" && v.trim() !== "",
  );
  const text = parts.join(" / ") || node.viewId?.split(":id/").at(-1) || "";
  const role = node.className?.split(".").at(-1) ?? "View";
  const composed = text ? `${role} "${text}"` : role;
  return composed.length > MAX_LABEL_LEN ? `${composed.slice(0, MAX_LABEL_LEN)}…` : composed;
}

function isInteractable(node: SnapNode): boolean {
  return Boolean(node.clickable || node.longClickable || node.editable || node.scrollable);
}

function area(node: SnapNode): number {
  const [l, t, r, b] = node.bounds;
  return Math.max(0, r - l) * Math.max(0, b - t);
}

/**
 * Candidates the model may re-bind to. Interactable nodes first because those
 * are the ones an operator can actually act on; labelled non-interactable
 * nodes follow so the model can still say "the text is there but nothing is
 * tappable", which is a materially different answer from "absent".
 */
function contains(outer: SnapNode, inner: SnapNode): boolean {
  const [ol, ot, or_, ob] = outer.bounds;
  const [il, it, ir, ib] = inner.bounds;
  return ol <= il && ot <= it && or_ >= ir && ob >= ib;
}

/**
 * Resolves a label node to the thing that is actually clickable.
 *
 * Android composes a button as a clickable container wrapping a non-clickable
 * text child, and the vision model naturally names the child - that is where
 * the word it recognised lives. Observed on the operator's own "Send" button,
 * where the model returned the TextView while the click target was its parent.
 * Handing that id back would produce an action the device silently drops, so
 * the answer is walked up to the nearest interactable ancestor, then failing
 * that to the smallest interactable node that encloses it.
 */
export function retargetToActionable(node: SnapNode, nodes: SnapNode[]): SnapNode {
  if (isInteractable(node)) return node;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>([node.id]);
  let current = node.parentId ? byId.get(node.parentId) : undefined;
  while (current && !seen.has(current.id)) {
    if (isInteractable(current)) return current;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // No parent chain (or a tree that omits it): fall back to geometry, taking
  // the tightest enclosing target so a full-screen container never wins.
  const enclosing = nodes
    .filter((n) => isInteractable(n) && contains(n, node))
    .sort((a, b) => area(a) - area(b));
  return enclosing[0] ?? node;
}

export function selectCandidates(nodes: SnapNode[]): SnapNode[] {
  // Smallest-first within each group: a full-screen scrollable container is far
  // less useful as a click target than the row inside it, and the cap is what
  // forces the choice. The groups are ranked separately and only then joined -
  // sorting the union by area would let a crowd of small labels push the real
  // controls past the cap, and the model is told to answer with coordinates
  // when no listed node covers the target, so crowding out an interactable
  // node actively pushes execution onto the least safe path.
  const bySize = (a: SnapNode, b: SnapNode): number => area(a) - area(b);
  const interactable = nodes.filter(isInteractable).sort(bySize);
  const labelled = nodes
    .filter((n) => !isInteractable(n) && (n.text?.trim() || n.contentDescription?.trim()))
    .sort(bySize);
  return [...interactable, ...labelled].slice(0, MAX_CANDIDATES);
}

/** Maps native screen bounds into the downsampled image's pixel space. */
function toImageSpace(bounds: [number, number, number, number], scale: AxisScale): number[] {
  const [left, top, right, bottom] = bounds;
  return [
    Math.round(left / scale.x),
    Math.round(top / scale.y),
    Math.round(right / scale.x),
    Math.round(bottom / scale.y),
  ];
}

interface AxisScale {
  x: number;
  y: number;
}

export function axisScales(shot: Screenshot): AxisScale {
  const { sourceWidth, sourceHeight, width, height } = shot;
  if (!sourceWidth || !sourceHeight || !width || !height) return { x: 1, y: 1 };
  return { x: sourceWidth / width, y: sourceHeight / height };
}

function buildPrompt(
  req: InspectRequest,
  snapshot: Snapshot,
  candidates: SnapNode[],
  shot: Screenshot,
  scale: AxisScale,
): string {
  const table = candidates
    .map((n) => `${n.id}\t[${toImageSpace(n.bounds, scale).join(",")}]\t${label(n)}`)
    .join("\n");

  return [
    "You are the vision recovery step of an Android operator agent. The operator could not resolve a target from the accessibility tree alone and needs you to look at the screen.",
    "",
    `QUESTION: ${req.question}`,
    ...(req.expectation ? [`OPERATOR EXPECTED: ${req.expectation}`] : []),
    "",
    `The attached image is the current screen, ${shot.width}x${shot.height} pixels.`,
    `Foreground package: ${snapshot.packageName}${snapshot.windowTitle ? ` (${snapshot.windowTitle})` : ""}.`,
    "",
    "Accessibility nodes currently on this screen, as `nodeId<TAB>[left,top,right,bottom]<TAB>label`, with bounds already in the image's pixel space:",
    table || "(none)",
    "",
    "Decide which of these is true and answer with ONE strict JSON object, no prose and no markdown fence:",
    '1. The target IS one of the listed nodes (it was simply labelled in a way the operator did not recognise). Answer {"resolution":"node","nodeId":"<id from the list>","confidence":"high|medium|low","observation":"<at most 200 characters on what is actually on screen>"}.',
    '2. The target is visible but NO listed node covers it - it is drawn pixels with no accessibility node. Answer {"resolution":"coordinates","x":<int>,"y":<int>,"confidence":"high|medium|low","observation":"..."} using image pixel coordinates at the centre of the target.',
    '3. The target is NOT on this screen. Answer {"resolution":"absent","observation":"<what is on screen instead>","suggestion":"<the single most likely next step, e.g. scroll down, go back, open a menu>"}.',
    "",
    "Keep every string short: the operator pays for this in context, and a long answer risks being cut off mid-JSON.",
    "Prefer option 1 whenever a listed node plausibly covers the target; only choose option 2 when nothing in the list does. Never invent a nodeId that is not in the list. Do not guess when the screen does not support an answer - choose option 3 and say so.",
  ].join("\n");
}

/** Tolerates a fenced or prose-wrapped object; the model is asked for bare JSON. */
export function parseVisionJson(raw: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`Vision model did not return JSON: ${raw.slice(0, 200)}`);
  }
  const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Vision model returned JSON that is not an object");
  }
  return parsed as Record<string, unknown>;
}

function asConfidence(value: unknown): Confidence {
  return value === "high" || value === "medium" || value === "low" ? value : "low";
}

function asText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

/** Geometry a viewer needs to make sense of a stored frame. */
export interface FrameRef {
  frameId: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface InspectDeps {
  vision?: VisionCaller;
  /**
   * Hands the captured frame to the frame store, if one is wired up, and
   * returns the reference the dashboard renders from. Injected rather than
   * imported so this module stays a pure function of its inputs in tests, and
   * so a caller that has no viewer (an eval, a sandbox sweep) stores nothing.
   */
  recordFrame?: (shot: {
    dataBase64: string;
    format: string;
    width: number;
    height: number;
    sourceWidth?: number;
    sourceHeight?: number;
  }) => FrameRef;
}

export async function inspectScreenVisually(
  gateway: VisionGatewayLike,
  req: InspectRequest,
  deps: InspectDeps = {},
): Promise<VisionResolution & { frame?: FrameRef }> {
  const deviceId = req.deviceId
    ?? gateway.listDevices().find((device) => gateway.isOnline(device.deviceId))?.deviceId;
  if (!deviceId) throw new Error("No Android device is connected to the bridge");
  if (!gateway.listDevices().some((device) => device.deviceId === deviceId)) {
    throw new Error(`Unknown Android device '${deviceId}'`);
  }
  if (!gateway.isOnline(deviceId)) throw new Error(`Selected Android device '${deviceId}' is offline`);

  // Captured together so the nodes describe the frame the model is looking at.
  // They are still two round trips, so a fast-moving screen can drift; that is
  // the same staleness `stale_snapshot` already covers on the action path.
  const [snapshotRes, shotRes] = await Promise.all([
    gateway.sendRequest(deviceId, { type: "get_screen" }),
    gateway.sendRequest(deviceId, {
      type: "capture_screenshot",
      maxDimension: IMAGE_MAX_DIMENSION,
      format: "jpeg",
      quality: IMAGE_QUALITY,
    }),
  ]);

  const snapshot = unwrap(snapshotRes) as Snapshot;
  const screen: ScreenRef = {
    packageName: snapshot.packageName,
    windowTitle: snapshot.windowTitle ?? null,
  };

  if (shotRes.ok !== true) {
    return {
      resolution: "unavailable",
      observation:
        "The screen could not be captured. Android blocks screenshots of secure windows " +
        `(FLAG_SECURE), which is the usual cause. Device reported: ${String(shotRes.error ?? "unknown")}.`,
    };
  }
  const shot = shotRes.result as Screenshot | null;
  if (!shot?.dataBase64) {
    return { resolution: "unavailable", observation: "The device returned an empty screenshot." };
  }

  // Per axis: the device truncates the scaled width and height independently
  // (`scaleToFit` in OperatorAccessibilityService.kt), so the two ratios are
  // not guaranteed equal and reusing the X ratio for Y skews every mapping
  // slightly - enough to miss a thin target or an edge.
  //
  // Both dimensions are honoured together or not at all: one without the other
  // would scale X natively while leaving Y in image space, landing in neither
  // coordinate system. Absent both means "not downsampled", which is defensive
  // only - the gateway pins the protocol version, so every client that can
  // connect sends both.
  const scale = axisScales(shot);
  // Recorded before the model is consulted so the operator can still see what
  // was looked at when the answer is "absent" or the screen moved underneath.
  const frame = deps.recordFrame?.(shot);
  // The tree and the frame are two round trips, so a transition between them
  // yields nodes from screen A over pixels from screen B. A `node` answer at
  // least carries a snapshotId the device rejects when stale; `coordinates`
  // has no such binding - tap_coordinates takes no snapshot - so nothing
  // downstream would catch it. Re-reading the tree afterwards bounds the race:
  // if the screen moved while we were looking, say so instead of answering.
  // Checked before the model call so a moved screen costs no tokens.
  const after = unwrap(
    await gateway.sendRequest(deviceId, { type: "get_screen" }),
  ) as Snapshot;
  if (screenSignature(after) !== screenSignature(snapshot)) {
    return {
      resolution: "unavailable",
      frame,
      observation:
        `The screen changed while it was being inspected (${snapshot.packageName} -> ` +
        `${after.packageName}), so the frame and the accessibility tree describe different ` +
        "screens. Wait for the UI to settle, then observe again.",
    };
  }

  const candidates = selectCandidates(snapshot.nodes ?? []);
  const call = deps.vision ?? callVisionModel;

  const answer = parseVisionJson(
    await call({
      imageBase64: shot.dataBase64,
      mimeType: shot.format === "jpeg" ? "image/jpeg" : "image/png",
      prompt: buildPrompt(req, snapshot, candidates, shot, scale),
    }),
  );

  // Vision can take tens of seconds. Re-bind the answer to a fresh snapshot
  // after inference so neither coordinates nor node ids escape from a frame
  // that has since gone stale. Android creates a new snapshot id on every
  // read, even when the content is unchanged, so compare content and return
  // the newest id rather than comparing ids directly.
  const latest = unwrap(
    await gateway.sendRequest(deviceId, { type: "get_screen" }),
  ) as Snapshot;
  if (screenSignature(latest) !== screenSignature(after)) {
    return {
      resolution: "unavailable",
      frame,
      observation:
        "The screen changed while vision was analyzing it. Re-observe the current screen " +
        "before taking any action.",
    };
  }

  const observation = asText(answer.observation, "The vision model returned no observation.");

  if (answer.resolution === "node") {
    const nodeId = typeof answer.nodeId === "string" ? answer.nodeId : "";
    // A hallucinated id would be rejected by the device anyway, but failing
    // here keeps the operator from burning a turn on an action it cannot run.
    if (!candidates.some((n) => n.id === nodeId)) {
      return {
        resolution: "absent",
        frame,
        observation,
        suggestion:
          `The vision model named node "${nodeId}", which is not on this screen. ` +
          "Re-observe with get_screen and search by label before trying again.",
        screen,
      };
    }
    const named = candidates.find((n) => n.id === nodeId) as SnapNode;
    const actionable = retargetToActionable(named, snapshot.nodes ?? []);
    return {
      resolution: "node",
      frame,
      snapshotId: latest.snapshotId,
      nodeId: actionable.id,
      confidence: asConfidence(answer.confidence),
      observation:
        actionable.id === nodeId
          ? observation
          : `${observation} (Resolved "${label(named)}" to its clickable container ${actionable.id}.)`,
      screen,
    };
  }

  if (answer.resolution === "coordinates") {
    const x = Number(answer.x);
    const y = Number(answer.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        resolution: "absent",
        frame,
        observation,
        suggestion: "The vision model returned no usable coordinates. Re-observe and replan.",
        screen,
      };
    }
    // A point well outside the frame is not a near-miss to be nudged back in -
    // it means the model was not working in image space at all. Clamping it
    // would turn a plainly wrong answer into a plausible tap on whatever sits
    // at the screen edge, which is the failure mode most likely to hit
    // something consequential. Only rounding-level slop is absorbed.
    if (
      x < -COORD_TOLERANCE_PX ||
      y < -COORD_TOLERANCE_PX ||
      x > shot.width + COORD_TOLERANCE_PX ||
      y > shot.height + COORD_TOLERANCE_PX
    ) {
      return {
        resolution: "absent",
        frame,
        observation,
        suggestion:
          `The vision model reported (${Math.round(x)},${Math.round(y)}), which is outside the ` +
          `${shot.width}x${shot.height} frame it was shown, so the answer cannot be trusted. ` +
          "Re-observe with get_screen and replan.",
        screen,
      };
    }

    // Back to native screen pixels, which is the space tap_coordinates uses.
    const width = shot.sourceWidth ?? shot.width;
    const height = shot.sourceHeight ?? shot.height;
    const clamp = (value: number, limit: number): number =>
      // `|| 0` normalises -0, which JSON.stringify would emit as `-0`.
      Math.min(Math.max(Math.round(value), 0), Math.max(limit - 1, 0)) || 0;
    return {
      resolution: "coordinates",
      frame,
      snapshotId: latest.snapshotId,
      x: clamp(x * scale.x, width),
      y: clamp(y * scale.y, height),
      confidence: asConfidence(answer.confidence),
      observation,
      screen,
    };
  }

  return {
    resolution: "absent",
    frame,
    observation,
    suggestion: asText(answer.suggestion, "Re-observe with get_screen and replan."),
    screen,
  };
}

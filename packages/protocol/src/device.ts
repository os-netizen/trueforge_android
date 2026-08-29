import { z } from "zod";
import { DeviceAction } from "./actions.js";
import { ActionResult, ScreenSnapshot, DeviceState, MediaState, NotificationState } from "./snapshots.js";

export { PROTOCOL_VERSION } from "./version.js";

/**
 * Server -> device requests. Each carries a requestId for correlation
 * over the WebSocket (doc section 26).
 */
export const DeviceRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("get_screen"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("execute_action"),
    requestId: z.string(),
    snapshotId: z.string().optional(),
    action: DeviceAction,
  }),
  z.object({
    type: z.literal("capture_screenshot"),
    requestId: z.string(),
    /**
     * Longest-edge cap in pixels. The device downsamples before encoding so a
     * full-resolution tablet frame never crosses the socket for a perception
     * call. Omitted means native resolution (what a pre-v4 client always does).
     */
    maxDimension: z.number().int().positive().optional(),
    format: z.enum(["png", "jpeg"]).optional(),
    /** JPEG quality 1-100; ignored for PNG. */
    quality: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal("get_device_state"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("get_media_state"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("get_notifications"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("cancel_task"),
    requestId: z.string(),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("request_approval"),
    requestId: z.string(),
    toolCallId: z.string(),
    intent: z.string(),
    /** Compact JSON of the pending action, for the expandable detail view. */
    actionJson: z.string(),
    /** Milliseconds the phone should keep the prompt alive before auto-deny. */
    timeoutMs: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("request_user_question"),
    requestId: z.string(),
    toolCallId: z.string(),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).max(5),
    timeoutMs: z.number().int().positive(),
  }),
]);

export type DeviceRequest = z.infer<typeof DeviceRequest>;

export const ApprovalDecisionResult = z.object({
  decision: z.enum(["allow", "deny"]),
  reason: z.string().nullable(),
});

export type ApprovalDecisionResult = z.infer<typeof ApprovalDecisionResult>;

export const UserQuestionResult = z.object({
  content: z.string().min(1),
});

export type UserQuestionResult = z.infer<typeof UserQuestionResult>;

export const ScreenshotResult = z.object({
  format: z.enum(["png", "jpeg"]),
  /** Base64 encoded image bytes. Ephemeral by policy (doc section 34). */
  dataBase64: z.string(),
  /** Encoded image size, after any downsampling. */
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /**
   * Native display size the frame was captured at. Divide by width/height -
   * per axis, since the device truncates each independently - to map a point
   * in image space back to a tappable screen coordinate.
   *
   * Optional only so a malformed client fails as "not downsampled" rather than
   * as a schema error; the gateway pins the protocol version exactly, so every
   * client that can connect sends both. They travel together: one without the
   * other would scale one axis natively and leave the other in image space,
   * landing in neither coordinate system.
   */
  sourceWidth: z.number().int().positive().optional(),
  sourceHeight: z.number().int().positive().optional(),
}).refine(
  (shot) => (shot.sourceWidth === undefined) === (shot.sourceHeight === undefined),
  { message: "sourceWidth and sourceHeight must be present together or not at all" },
);

export type ScreenshotResult = z.infer<typeof ScreenshotResult>;

/** Device -> server responses, correlated by requestId. */
export const DeviceResponse = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("get_screen"),
    requestId: z.string(),
    ok: z.boolean(),
    result: ScreenSnapshot.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("execute_action"),
    requestId: z.string(),
    ok: z.boolean(),
    result: ActionResult.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("capture_screenshot"),
    requestId: z.string(),
    ok: z.boolean(),
    result: ScreenshotResult.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("get_device_state"),
    requestId: z.string(),
    ok: z.boolean(),
    result: DeviceState.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("get_media_state"),
    requestId: z.string(),
    ok: z.boolean(),
    result: MediaState.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("get_notifications"),
    requestId: z.string(),
    ok: z.boolean(),
    result: z.array(NotificationState).nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("cancel_task"),
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("request_approval"),
    requestId: z.string(),
    ok: z.boolean(),
    result: ApprovalDecisionResult.nullable(),
    error: z.string().nullable(),
  }),
  z.object({
    type: z.literal("request_user_question"),
    requestId: z.string(),
    ok: z.boolean(),
    result: UserQuestionResult.nullable(),
    error: z.string().nullable(),
  }),
]);

export type DeviceResponse = z.infer<typeof DeviceResponse>;

/** Hello sent by the device on connect/reconnect. */
export const DeviceHello = z.object({
  protocolVersion: z.number().int(),
  deviceId: z.string(),
  model: z.string().nullable(),
  androidVersion: z.string().nullable(),
  accessibilityServiceEnabled: z.boolean(),
});

export type DeviceHello = z.infer<typeof DeviceHello>;

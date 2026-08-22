import { z } from "zod";
import { DeviceAction } from "./actions.js";
import { ActionResult, ScreenSnapshot, DeviceState } from "./snapshots.js";

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
  }),
  z.object({
    type: z.literal("get_device_state"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("cancel_task"),
    requestId: z.string(),
    taskId: z.string(),
  }),
]);

export type DeviceRequest = z.infer<typeof DeviceRequest>;

export const ScreenshotResult = z.object({
  format: z.literal("png"),
  /** Base64 encoded PNG bytes. Ephemeral by policy (doc section 34). */
  dataBase64: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

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
    type: z.literal("cancel_task"),
    requestId: z.string(),
    ok: z.boolean(),
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

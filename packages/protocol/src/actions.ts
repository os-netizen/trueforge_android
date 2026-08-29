import { z } from "zod";

/**
 * Generic device actions the agent can request.
 * Hierarchy (doc section 15): semantic node actions first, then gestures, then coordinates.
 */
export const DeviceAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click_node"),
    snapshotId: z.string(),
    nodeId: z.string(),
  }),
  z.object({
    type: z.literal("long_click_node"),
    snapshotId: z.string(),
    nodeId: z.string(),
  }),
  z.object({
    type: z.literal("set_text"),
    snapshotId: z.string(),
    nodeId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal("scroll"),
    snapshotId: z.string(),
    direction: z.enum(["up", "down", "left", "right"]),
    /** Optional node to scroll within; otherwise scroll the screen. */
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
    action: z.enum([
      "back", "home", "recents", "notifications", "quick_settings",
      "power_dialog", "lock_screen", "screenshot", "dpad_up", "dpad_down",
      "dpad_left", "dpad_right", "dpad_center",
    ]),
  }),
  z.object({
    type: z.literal("launch_app"),
    packageName: z.string(),
  }),
  z.object({
    type: z.literal("media_control"),
    action: z.enum(["play", "pause", "stop", "next", "previous"]),
    /** Optional package selector when more than one media session exists. */
    packageName: z.string().optional(),
  }),
  z.object({
    type: z.literal("notification_action"),
    key: z.string(),
    action: z.enum(["open", "dismiss", "invoke"]),
    actionIndex: z.number().int().nonnegative().optional(),
  }),
]);

export type DeviceAction = z.infer<typeof DeviceAction>;

/** Risk classification used for approval policy (doc section 22). */
export const ActionRisk = z.enum(["read", "navigation", "consequential"]);

export type ActionRisk = z.infer<typeof ActionRisk>;

export function classifyActionRisk(action: DeviceAction): ActionRisk {
  switch (action.type) {
    case "click_node":
    case "long_click_node":
      // Node clicks are context dependent; the server/agent layer may upgrade
      // these to consequential based on target semantics. Default to navigation.
      return "navigation";
    case "set_text":
    case "scroll":
      return "navigation";
    case "tap_coordinates":
    case "swipe":
      return "navigation";
    case "global_action":
    case "launch_app":
    case "media_control":
    case "notification_action":
      return "navigation";
  }
}

import { z } from "zod";

/**
 * Compact, model friendly accessibility snapshot (doc section 14).
 * Node IDs are scoped to a snapshot and never valid across snapshots.
 */
export const AccessibilityNode = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  className: z.string().nullable(),
  text: z.string().nullable(),
  contentDescription: z.string().nullable(),
  viewId: z.string().nullable(),
  /** [left, top, right, bottom] in screen pixels. */
  bounds: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
  clickable: z.boolean(),
  longClickable: z.boolean(),
  editable: z.boolean(),
  scrollable: z.boolean(),
  focusable: z.boolean(),
  enabled: z.boolean(),
  selected: z.boolean(),
  checked: z.boolean().nullable(),
});

export type AccessibilityNode = z.infer<typeof AccessibilityNode>;

export const ScreenSnapshot = z.object({
  deviceId: z.string(),
  snapshotId: z.string(),
  packageName: z.string(),
  windowTitle: z.string().nullable(),
  timestamp: z.number().int(),
  nodes: z.array(AccessibilityNode),
});

export type ScreenSnapshot = z.infer<typeof ScreenSnapshot>;

export const DeviceState = z.object({
  deviceId: z.string(),
  online: z.boolean(),
  foregroundPackage: z.string().nullable(),
  orientation: z.enum(["portrait", "landscape"]),
  accessibilityServiceEnabled: z.boolean(),
  lastSnapshotId: z.string().nullable(),
  activeTaskId: z.string().nullable(),
});

export type DeviceState = z.infer<typeof DeviceState>;

/** Result payload returned by execute_action (doc section 17). */
export const ActionResult = z.object({
  status: z.enum(["success", "failed", "stale_snapshot", "unsupported"]),
  error: z.string().nullable(),
  screenChanged: z.boolean(),
  foregroundPackage: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
});

export type ActionResult = z.infer<typeof ActionResult>;

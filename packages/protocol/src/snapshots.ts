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
  actions: z.array(z.string()),
  range: z.object({ min: z.number(), max: z.number(), current: z.number() }).nullable(),
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
  screenInteractive: z.boolean(),
  deviceLocked: z.boolean(),
  keyguardShowing: z.boolean(),
  batteryPercent: z.number().int().min(0).max(100).nullable(),
  charging: z.boolean(),
  networkValidated: z.boolean(),
  networkMetered: z.boolean(),
  mediaVolume: z.number().int().nonnegative(),
  mediaVolumeMax: z.number().int().nonnegative(),
});

export type DeviceState = z.infer<typeof DeviceState>;

export const MediaSessionState = z.object({
  packageName: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  album: z.string().nullable(),
  playbackState: z.enum([
    "none",
    "stopped",
    "paused",
    "playing",
    "fast_forwarding",
    "rewinding",
    "buffering",
    "connecting",
    "skipping",
    "error",
    "unknown",
  ]),
  positionMs: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  supportedActions: z.array(
    z.enum(["play", "pause", "stop", "next", "previous", "seek"]),
  ),
});

export type MediaSessionState = z.infer<typeof MediaSessionState>;

export const MediaState = z.object({
  /** False means Android notification-listener access has not been granted. */
  available: z.boolean(),
  permissionRequired: z.boolean(),
  sessions: z.array(MediaSessionState),
});

export type MediaState = z.infer<typeof MediaState>;

export const NotificationState = z.object({
  key: z.string(),
  packageName: z.string(),
  title: z.string().nullable(),
  text: z.string().nullable(),
  postedAt: z.number().int(),
  ongoing: z.boolean(),
  actions: z.array(z.string()),
});

export type NotificationState = z.infer<typeof NotificationState>;

/** Result payload returned by execute_action (doc section 17). */
export const ActionResult = z.object({
  status: z.enum(["success", "failed", "stale_snapshot", "unsupported"]),
  error: z.string().nullable(),
  screenChanged: z.boolean(),
  foregroundPackage: z.string().nullable(),
  latencyMs: z.number().int().nonnegative(),
});

export type ActionResult = z.infer<typeof ActionResult>;

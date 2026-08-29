/**
 * In-memory store for screen frames the agent captured.
 *
 * Screenshots must not travel through the transcript as base64. A 1024px JPEG
 * is a few hundred kilobytes of text; `tool.response.content` is a string that
 * the transcript clips at 4000 characters, so an inlined frame would arrive
 * both unusable and enormous, on every reconnect and every history rebuild.
 * Instead the frame stays here and the tool result carries only a `frameId`,
 * which the dashboard turns into one ordinary <img> request.
 *
 * Deliberately not on disk. `capture_screenshot` tells the model the image is
 * never persisted, and a phone screen is exactly the kind of thing that should
 * not outlive the process that looked at it. The cap is a hard bound on that
 * exposure as much as on memory: old frames fall out of a finished run, which
 * is why the dashboard renders a placeholder rather than an image for history.
 */
import { randomUUID } from "node:crypto";

/** Frames kept at once. Around 30-60 MB at 1024px JPEG, and a run rarely takes more. */
const MAX_FRAMES = 60;

export interface StoredFrame {
  id: string;
  bytes: Buffer;
  mimeType: string;
  /** Size of the image as captured (what the model was shown). */
  width: number;
  height: number;
  /** Native screen size, so a point read off the image can be scaled back. */
  sourceWidth: number;
  sourceHeight: number;
  capturedAt: string;
}

export interface FrameInput {
  dataBase64: string;
  format?: string | null;
  width?: number | null;
  height?: number | null;
  sourceWidth?: number | null;
  sourceHeight?: number | null;
}

/** Insertion-ordered, which is what makes the oldest key the eviction target. */
const frames = new Map<string, StoredFrame>();

export function storeFrame(input: FrameInput): StoredFrame {
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  const frame: StoredFrame = {
    id: randomUUID(),
    bytes: Buffer.from(input.dataBase64, "base64"),
    mimeType: input.format === "png" ? "image/png" : "image/jpeg",
    width,
    height,
    sourceWidth: input.sourceWidth ?? width,
    sourceHeight: input.sourceHeight ?? height,
    capturedAt: new Date().toISOString(),
  };
  frames.set(frame.id, frame);
  while (frames.size > MAX_FRAMES) {
    const oldest = frames.keys().next();
    if (oldest.done) break;
    frames.delete(oldest.value);
  }
  return frame;
}

export function getFrame(id: string): StoredFrame | undefined {
  return frames.get(id);
}

/**
 * What goes into the tool's text result: the id plus the geometry a caller
 * needs, and never the pixels. `frameId` is the token the transcript builder
 * looks for, so any tool that captures a frame becomes renderable by including
 * this object.
 */
export function frameReference(frame: StoredFrame): {
  frameId: string;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
} {
  return {
    frameId: frame.id,
    width: frame.width,
    height: frame.height,
    sourceWidth: frame.sourceWidth,
    sourceHeight: frame.sourceHeight,
  };
}

/** Test seam; the process is otherwise the store's whole lifetime. */
export function clearFrames(): void {
  frames.clear();
}

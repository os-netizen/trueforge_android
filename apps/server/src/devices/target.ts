import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const secret = randomBytes(32);

/**
 * Creates an opaque capability for one Android device. The model receives the
 * capability, never a free choice of device ID, so a run cannot redirect a
 * tool call to another online phone by changing an argument.
 */
export function createDeviceTarget(deviceId: string): string {
  const encoded = Buffer.from(deviceId, "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function resolveDeviceTarget(target: string): string {
  const separator = target.lastIndexOf(".");
  if (separator <= 0) throw new Error("Invalid Android device target");
  const encoded = target.slice(0, separator);
  const suppliedText = target.slice(separator + 1);
  const supplied = Buffer.from(suppliedText, "base64url");
  const expected = createHmac("sha256", secret).update(encoded).digest();
  if (
    supplied.toString("base64url") !== suppliedText
    || supplied.length !== expected.length
    || !timingSafeEqual(supplied, expected)
  ) {
    throw new Error("Invalid Android device target");
  }
  const deviceId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!deviceId) throw new Error("Invalid Android device target");
  return deviceId;
}

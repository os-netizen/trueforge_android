import type { DeviceGateway } from "../devices/gateway.js";
import type { ApprovalOutcome, PendingApprovalInfo } from "./turn-loop.js";

/** How long the phone keeps an approval prompt alive before auto-denying. */
export const APPROVAL_TIMEOUT_MS = 120_000;

/** Grace on top of the phone's own deadline so the device answers first. */
const GATEWAY_SLACK_MS = 5_000;

/**
 * Asks the connected phone to approve one pending tool call.
 *
 * Fail-closed is non-negotiable: a timeout, an offline device, a transport
 * error, or a malformed response all resolve to deny.
 */
export async function requestPhoneApproval(
  gateway: DeviceGateway,
  info: PendingApprovalInfo,
): Promise<ApprovalOutcome> {
  const deviceId = gateway.listDevices().find((d) => gateway.isOnline(d.deviceId))?.deviceId;
  if (!deviceId) {
    return { decision: "deny", reason: "No Android device was connected to approve the action" };
  }

  let response;
  try {
    response = await gateway.sendRequest(
      deviceId,
      {
        type: "request_approval",
        toolCallId: info.toolCallId,
        intent: info.intent,
        actionJson: info.actionJson,
        timeoutMs: APPROVAL_TIMEOUT_MS,
      },
      { timeoutMs: APPROVAL_TIMEOUT_MS + GATEWAY_SLACK_MS },
    );
  } catch (error) {
    return {
      decision: "deny",
      reason: `Approval could not be delivered to the device: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (response.type !== "request_approval" || response.ok !== true || !response.result) {
    return { decision: "deny", reason: response.error ?? "Device returned no approval decision" };
  }
  const { decision, reason } = response.result;
  return decision === "allow"
    ? { decision: "allow" }
    : { decision: "deny", reason: reason ?? "User denied on device" };
}

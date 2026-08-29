import type { DeviceGateway } from "../devices/gateway.js";
import type { PendingQuestionInfo, QuestionOutcome } from "../approvals/turn-loop.js";

export const QUESTION_TIMEOUT_MS = 10 * 60_000;
const GATEWAY_SLACK_MS = 5_000;

export async function requestPhoneAnswer(
  gateway: DeviceGateway,
  info: PendingQuestionInfo,
): Promise<QuestionOutcome> {
  const deviceId = gateway.listDevices().find((device) => gateway.isOnline(device.deviceId))?.deviceId;
  if (!deviceId) throw new Error("No Android device was connected to answer the question");

  const response = await gateway.sendRequest(deviceId, {
    type: "request_user_question",
    toolCallId: info.toolCallId,
    question: info.question,
    options: info.options,
    timeoutMs: QUESTION_TIMEOUT_MS,
  }, { timeoutMs: QUESTION_TIMEOUT_MS + GATEWAY_SLACK_MS });

  if (response.type !== "request_user_question" || response.ok !== true || !response.result) {
    throw new Error(response.error ?? "Device returned no answer");
  }
  return response.result;
}

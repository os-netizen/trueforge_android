import type { AndroidEvalCase } from "../types.js";
import { approvalAllowDismiss } from "./approval-allow-dismiss.js";
import { approvalDenyDismiss } from "./approval-deny-dismiss.js";
import { sandboxBulkDismiss } from "./sandbox-bulk-dismiss.js";
import { youtubeLatestPauseHome } from "./youtube-latest-pause-home.js";

export const evalCases: AndroidEvalCase[] = [
  youtubeLatestPauseHome,
  approvalAllowDismiss,
  approvalDenyDismiss,
  sandboxBulkDismiss,
];

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { config, OPENCODE_GO_BASE_URL, openCodeGoApiKey } from "../config.js";
import {
  agentReasoningEffort,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "./reasoning.js";
import { trueForgeClient } from "./client.js";

/**
 * System instructions for the Android operator agent
 * (handoff doc section 33 operating policy).
 */
export const ANDROID_OPERATOR_INSTRUCTIONS = `You operate a physical Android phone through the connected device tools.

Operating policy:
1. Observe first with get_screen. For a specific target use find_nodes instead of requesting more tree data. Nodes are compact: {id,p,t,d,r:role,v:view id,f:flags,a:actions,rng:[min,max,current],b:bounds}. Responses are deliberately bounded to preserve context. Use only fields declared by each tool schema: inspect a schema once when uncertain, retain it, and never guess arguments, query syntax, nested actions, or unavailable host-control tools. A validation error is not a reason to improvise another shape.
2. Node ids are valid ONLY within the snapshot that produced them. Every node action must include that snapshotId. If stale_snapshot is returned, search or observe again instead of retrying blind.
3. Action hierarchy: prefer semantic node actions (click_node, set_text). For audio/video playback, use get_media_state and media_control; never guess player coordinates or infer playback by comparing UI timestamps. Use scroll, swipe, or tap_coordinates only when no semantic action applies. global_action covers back/home/recents/notifications. launch_app opens installed packages.
4. Prefer execute_and_observe for navigation and wait_for for asynchronous UI; they avoid race-prone action/poll loops. An accepted action or screenChanged only proves delivery or a UI event, not success. After every action, verify the exact expected postcondition with the narrowest authoritative tool: the old target disappeared, the expected node/text/package appeared, or get_media_state confirms playback. Do not continue from an unverified assumption.
5. Recovery is bounded by semantic step, not by tool variant: if the observed postcondition does not match, re-observe, classify what changed, and replan. Count coordinate retries, vision retries, alternate tools, and schema mistakes toward the same maximum of three failed attempts. Never repeat the same vision question on an unchanged screen. For a modal with no semantic close action, make at most one grounded coordinate attempt; if it remains, use global Back once and verify. If set_text fails and a fresh search exposes no editable node or set-text action, stop that step and report the accessibility limitation instead of tapping unrelated nodes, probing ADB or shell access, or spawning vision to solve text entry. Once the step reaches three failures, stop immediately and report status honestly.
6. Approval boundary: consequential external actions - sending messages, sharing or posting content, deleting data, dismissing others' notifications, creating public links, changing security-relevant settings - MUST be executed through commit_action, never execute_action. Prepare the full action first (navigate, type the draft, stage the attachment), then call commit_action once with a one-sentence intent. commit_action pauses until the user decides. If the user denies, do not retry or route around it with execute_action; explain what was denied and stop that step.
7. Prohibited entirely: banking and payment apps, financial transfers, authenticator or OTP flows, password managers, attempts to bypass secure windows or app protections.
8. Navigation, searching within apps, opening apps, and typing drafts are low-risk and allowed without approval.
9. Finish with a concise report: what was done, how it was verified, final outcome.
10. Visual isolation: the accessibility tree is your only direct perception path. Never call inspect_screen_visually or capture_screenshot on the main thread. Vision has exactly two eligible uses, and both are delegated to a sub-agent: (a) navigation recovery - get_screen and find_nodes cannot locate an actionable UI target because the target is drawn, unlabelled, or visually represented; and (b) visual verification - the task states a visual property that decides whether a step succeeded or which item satisfies it (a colour, pattern, shape, orientation, or which of several pictured items matches the description), and no node text, contentDescription, or other authoritative non-visual field settles it. Treat (b) as the general rule, not a special case: whenever success depends on how something looks rather than on what a label claims - for example confirming that a bedsheet a listing calls "red" is actually red before selecting it - verify it visually before acting on it or reporting it as done. Vision is still not OCR and not a content reader: do not use it to read, transcribe, summarize, or narrate screen content such as posts, messages, documents, charts, or videos, and never to recover text that structured accessibility nodes already carry or could carry. If the nodes do not expose the text you need, report that limitation rather than screenshotting it. For an eligible problem, create one short-lived sub-agent named "vision-recovery", ask it exactly one question - where the actionable target is, or whether the named visual property holds on the current stable screen - receive its compact result, and continue on the main thread. Use no more than one vision child per target, and one per verification question, on the same observed screen.
11. Vision sub-agent contract: tell every vision-recovery sub-agent that it is a strictly read-only visual observer that either locates an actionable UI target or answers one closed visual-property question, and is never a general content reader. The sub-agent does not automatically inherit the run routing context: copy the exact opaque deviceTarget from the current run into its input and require it in every android-tool-bridge call. For a location question it should call inspect_screen_visually (preferred because it returns compact grounded JSON) and may fall back to capture_screenshot; for a verification question it should call capture_screenshot and judge the frame itself, since inspect_screen_visually only resolves targets. It must not transcribe or report unrelated screen content, and must not navigate, scroll, tap, type, launch apps, call execute_action/execute_and_observe/commit_action, or spawn another agent. If the frame is blank, transitional, stale, or does not visibly contain the named target or property, it must return "unavailable" or "absent" and never infer coordinates or a verdict from expectation, from listing text, or from an earlier frame. If the target is not on the current screen, it reports "absent" plus the next navigation step and closes; you perform that step and, if visual localization is still needed on a genuinely new stable screen, spawn a fresh vision-recovery sub-agent. Require exactly one result: for location, snapshotId and nodeId where possible, coordinates only for a genuinely drawn control visibly grounded in the current frame, or an honest absent/unavailable result; for verification, a yes/no/unclear verdict plus one short sentence of the visible evidence it is based on. An "unclear" verdict is a real answer - do not treat it as confirmation. The main agent owns every device action, verifies the postcondition, and owns every approval boundary.
12. Code Mode: after the first read-only discovery, classify every requested bulk operation. If the app exposes one genuine native bulk control, use that direct action. Otherwise, if three or more matching targets require the same per-item mutation (dismissing several notifications, collecting items across repeated scrolls, or extracting fields from many nodes), switch to Code Mode before mutating the first target: never begin a direct per-item loop and switch to a script later. Write one Python script in the sandbox that chains the android-tool-bridge tools via mcp_client, filters and aggregates in code, and prints only a compact summary (counts, ids acted on, final state). Fetch structured data with get_screen/find_nodes/get_notifications inside the script rather than pasting large observations into it. Code Mode cannot see pixels or improve, derive, or validate visual coordinates. Do not call inspect_screen_visually or capture_screenshot from Code Mode; eligible visual navigation recovery always uses the short-lived vision-recovery sub-agent described above. Do not probe ADB, shell, or host device-control access from the sandbox; the declared MCP tools are authoritative. commit_action called from a script still pauses for approval - route consequential steps through it exactly as in direct calls, and note that execute_action refuses consequential actions outright, script or not. For a single action, keep using direct tool calls; never use the sandbox decoratively.`;

/**
 * Whether the standalone runtime can give the agent a sandbox.
 *
 * The runtime's own startup probe decides this from the host binaries it needs
 * for the bubblewrap-isolated local fallback (bwrap, socat, rg, a shell and
 * python3); it logs "Local sandbox fallback is available" when they are all
 * present. We mirror that check here rather than smoke-testing a turn on every
 * run - a turn costs a model call, this costs four stats. SANDBOX_ENABLED
 * overrides it in both directions (1/true to force on, 0/false to force off),
 * which is also how a remote Daytona provider would be declared.
 */
export function sandboxAvailable(): boolean {
  if (cachedSandboxAvailable === null) cachedSandboxAvailable = probeSandbox();
  return cachedSandboxAvailable;
}

let cachedSandboxAvailable: boolean | null = null;

const SANDBOX_HOST_BINARIES = ["bwrap", "socat", "rg", "python3"];

function probeSandbox(): boolean {
  const override = process.env.SANDBOX_ENABLED;
  if (override !== undefined && override !== "") {
    return override === "1" || override.toLowerCase() === "true";
  }
  if (process.platform !== "linux") return false;
  const pathDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  return SANDBOX_HOST_BINARIES.every((binary) =>
    pathDirs.some((dir) => {
      try {
        accessSync(join(dir, binary), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

export async function registerModelProvider(): Promise<void> {
  const client = trueForgeClient();
  const manifest: TrueForgeApi.CustomModelProvider = {
    type: "custom",
    name: config.modelProviderName,
    baseUrl: OPENCODE_GO_BASE_URL,
    auth: { apiKey: openCodeGoApiKey() },
    // Deduped: main and vision default to the same vision-capable model, and
    // declaring one model twice is not something the provider manifest allows.
    models: [...new Set([config.mainModelId, config.visionModelId])].map((modelId) => ({
      name: modelId,
      modelId,
      // Declared so the runtime (and its UI) knows an effort may be set on
      // this provider at all; the upstream endpoint accepts exactly this enum
      // and rejects anything else, so advertising the full list is honest.
      properties: { reasoningEfforts: [...REASONING_EFFORTS] as ReasoningEffort[] },
    })),
  };
  await client.settings.modelProviders.createOrUpdate({ manifest });
}

export async function registerMcpServer(
  name: string,
  url: string,
  description: string,
): Promise<void> {
  const client = trueForgeClient();
  const manifest: TrueForgeApi.McpServerManifest = {
    name,
    type: "remote",
    url,
    description,
  };
  await client.settings.mcpServers.createOrUpdate({ manifest });
}

export interface EnsureAgentOptions {
  agentName: string;
  mcpServerName: string;
  /** Enables Code Mode. Off by default so the stack never depends on it. */
  sandbox?: boolean;
  /** Overrides the live setting; omitted means "whatever is configured now". */
  reasoningEffort?: ReasoningEffort;
}

export async function ensureAgent(opts: EnsureAgentOptions): Promise<void> {
  const client = trueForgeClient();

  const spec: TrueForgeApi.AgentSpec = {
    model: {
      name: `${config.modelProviderName}/${config.mainModelId}`,
      // Forwarded to the provider as `reasoning_effort`. Changing it means
      // replacing this manifest, which is why the reasoning API re-runs
      // ensureAgent rather than poking the running session.
      params: { reasoningEffort: opts.reasoningEffort ?? agentReasoningEffort() },
    },
    instructions: ANDROID_OPERATOR_INSTRUCTIONS,
    mcpServers: [
      {
        name: opts.mcpServerName,
        enableTools: ["@all"],
        // Navigation stays ungated; only the consequential commit step pauses.
        requireApprovalForTools: ["commit_action"],
      },
    ],
    config: {
      iterationLimit: 40,
      sandbox: { enabled: opts.sandbox ?? false },
      // Declared rather than left to the runtime default: visual navigation
      // recovery is isolated in the vision-recovery sub-agent from item 11.
      // Sub-agents inherit this agent's model, which is why the main model must
      // stay vision-capable (see config.ts).
      dynamicSubAgents: { enabled: true },
    },
  };

  try {
    await client.agents.create({
      name: opts.agentName,
      manifest: spec,
    });
  } catch (err) {
    if (!isConflict(err)) throw err;
    // Name is immutable but the manifest can be replaced wholesale.
    const existing = await findAgentByName(opts.agentName);
    if (!existing) throw err;
    await client.agents.update(existing.id, { manifest: spec });
  }
}

function isConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    "statusCode" in err &&
    (err as { statusCode?: number }).statusCode === 409
  );
}

async function findAgentByName(name: string): Promise<TrueForgeApi.Agent | null> {
  const client = trueForgeClient();
  const listed = await client.agents.list();
  return listed.data.find((a) => a.name === name) ?? null;
}

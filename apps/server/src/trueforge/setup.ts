import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { config, OPENCODE_GO_BASE_URL, openCodeGoApiKey } from "../config.js";
import { trueForgeClient } from "./client.js";

/**
 * System instructions for the Android operator agent
 * (handoff doc section 33 operating policy).
 */
export const ANDROID_OPERATOR_INSTRUCTIONS = `You operate a physical Android phone through the connected device tools.

Operating policy:
1. Observe first: call get_screen before acting. Ground every decision in what you actually see. Snapshot nodes are compact: {id, p:parent id, t:text, d:contentDescription, f:flags (c=clickable, l=long-clickable, e=editable text field, s=scrollable), b:[left,top,right,bottom]}. Absent fields are null.
2. Node ids are valid ONLY within the snapshot that produced them. If an action returns stale_snapshot, call get_screen again instead of retrying blind.
3. Action hierarchy: prefer semantic node actions (click_node, set_text). Use scroll, swipe, or tap_coordinates only when no node action applies. global_action covers back/home/recents/notifications. launch_app opens installed packages.
4. Never assume success. After every meaningful action, observe again and verify progress toward the goal before continuing.
5. Recovery: if observed state does not match expectation, re-observe and classify what changed, then replan. Do not loop. After three failed attempts on the same step, report status honestly and stop.
6. Approval boundary: consequential external actions - sending messages, sharing or posting content, deleting data, creating public links, changing security-relevant settings - MUST be prepared fully, then presented to the user for explicit approval before commitment. Wait for approval.
7. Prohibited entirely: banking and payment apps, financial transfers, authenticator or OTP flows, password managers, attempts to bypass secure windows or app protections.
8. Navigation, searching within apps, opening apps, and typing drafts are low-risk and allowed without approval.
9. Finish with a concise report: what was done, how it was verified, final outcome.`;

export async function registerModelProvider(): Promise<void> {
  const client = trueForgeClient();
  const manifest: TrueForgeApi.CustomModelProvider = {
    type: "custom",
    name: config.modelProviderName,
    baseUrl: OPENCODE_GO_BASE_URL,
    auth: { apiKey: openCodeGoApiKey() },
    models: [
      {
        name: config.mainModelId,
        modelId: config.mainModelId,
        properties: {},
      },
      {
        name: config.visionModelId,
        modelId: config.visionModelId,
        properties: {},
      },
    ],
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
}

export async function ensureAgent(opts: EnsureAgentOptions): Promise<void> {
  const client = trueForgeClient();

  const spec: TrueForgeApi.AgentSpec = {
    model: { name: `${config.modelProviderName}/${config.mainModelId}` },
    instructions: ANDROID_OPERATOR_INSTRUCTIONS,
    mcpServers: [
      {
        name: opts.mcpServerName,
        enableTools: ["@all"],
        // Tool-level approval gating lands in Milestone 6 via
        // requireApprovalForTools; navigation stays ungated for now.
        requireApprovalForTools: [],
      },
    ],
    config: { iterationLimit: 40 },
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

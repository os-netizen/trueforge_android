import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { config, OPENCODE_GO_BASE_URL, openCodeGoApiKey } from "../config.js";
import { FAKE_MCP_SERVER_NAME } from "../mcp/fake-device.js";
import { trueForgeClient } from "./client.js";

/**
 * System instructions for the Android operator agent. Kept minimal for the
 * fake-device milestone; grows into the full operating policy in section 33.
 */
const ANDROID_OPERATOR_INSTRUCTIONS = `You are an Android operator agent. You control a physical Android device through tools.

Current stage: the device is simulated by a fake tool server exposing get_test_screen and execute_test_action.

Policy:
1. Observe before acting: call get_test_screen to inspect state.
2. Act using the smallest sufficient action.
3. Never assume an action worked: after acting, observe again and verify.
4. Report progress concisely.`;

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

export async function registerMcpServer(mcpUrl: string): Promise<void> {
  const client = trueForgeClient();
  const manifest: TrueForgeApi.McpServerManifest = {
    name: FAKE_MCP_SERVER_NAME,
    type: "remote",
    url: mcpUrl,
    description:
      "Simulated Android device: accessibility snapshots and generic action execution for loop verification.",
  };
  await client.settings.mcpServers.createOrUpdate({ manifest });
}

export interface RegisteredAgent {
  name: string;
}

export async function ensureAgent(): Promise<RegisteredAgent> {
  const client = trueForgeClient();

  const spec: TrueForgeApi.AgentSpec = {
    model: { name: `${config.modelProviderName}/${config.mainModelId}` },
    instructions: ANDROID_OPERATOR_INSTRUCTIONS,
    mcpServers: [
      {
        name: FAKE_MCP_SERVER_NAME,
        enableTools: ["@all"],
        requireApprovalForTools: [],
      },
    ],
    config: { iterationLimit: 10 },
  };

  try {
    await client.agents.create({
      name: config.agentName,
      manifest: spec,
    });
    return { name: config.agentName };
  } catch (err) {
    if (!isConflict(err)) throw err;
    // Name is immutable but the manifest can be replaced wholesale.
    const existing = await findAgentByName(config.agentName);
    if (!existing) throw err;
    await client.agents.update(existing.id, { manifest: spec });
    return { name: config.agentName };
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

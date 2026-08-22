/**
 * Milestone 4 runner: registers the real Android Tool Bridge with TrueForge
 * and executes a natural-language task against the physical phone.
 *
 * Prereqs: bridge server running (`npm start`) so the MCP endpoint is live
 * and the phone is connected. Then:
 *
 *   npx tsx --env-file=.env scripts/task.ts "Open WhatsApp and search for Akash"
 */
import { config } from "../src/config.js";
import { ANDROID_TOOL_BRIDGE_NAME } from "../src/mcp/android-tools.js";
import { trueForgeClient } from "../src/trueforge/client.js";
import {
  ensureAgent,
  registerMcpServer,
  registerModelProvider,
} from "../src/trueforge/setup.js";
import { TurnLog } from "../src/trueforge/turn-log.js";

const OPERATOR_AGENT_NAME = process.env.AGENT_NAME ?? "android-operator";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    console.error("usage: tsx scripts/task.ts \"<natural language task>\"");
    process.exit(1);
  }

  const client = trueForgeClient();

  console.log("[1] Registering model provider + tool bridge");
  await registerModelProvider();
  const bridgeUrl = `http://${config.mcpHost}:${config.mcpPort}/mcp`;
  await registerMcpServer(
    ANDROID_TOOL_BRIDGE_NAME,
    bridgeUrl,
    "Physical Android device control: accessibility snapshots, generic actions, screenshots, device state.",
  );
  await ensureAgent({ agentName: OPERATOR_AGENT_NAME, mcpServerName: ANDROID_TOOL_BRIDGE_NAME });
  console.log(`    agent ready: ${OPERATOR_AGENT_NAME} (bridge: ${bridgeUrl})`);

  console.log("[2] Creating session");
  const session = await client.sessions.create({ agent: { name: OPERATOR_AGENT_NAME } });
  const sessionId = session.data.id;
  console.log(`    session ${sessionId}`);

  const log = new TurnLog();
  log.user(prompt);
  console.log("[3] Streaming turn...\n");

  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [{ type: "user.message", content: prompt }],
  });
  for await (const event of stream) {
    log.ingest(event as never);
  }
  log.summarize();
}

main().catch((err) => {
  console.error("TASK FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

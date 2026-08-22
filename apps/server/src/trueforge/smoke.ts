/**
 * Milestone 1 smoke test (handoff doc section 46).
 *
 * Proves the full TrueForge tool loop with a fake device before any real
 * Android work:
 *
 *   1. Verify TrueForge is reachable.
 *   2. Register the OpenCode Go model provider (DeepSeek V4 Flash).
 *   3. Start the fake Android MCP tool server.
 *   4. Register it as a remote MCP server in TrueForge.
 *   5. Create/refresh the android-operator agent.
 *   6. Create a session and stream one turn that forces a tool call.
 *   7. Print the execution trace; exit nonzero on failure.
 */
import { config } from "../config.js";
import { startFakeDeviceMcpServer } from "../mcp/fake-device.js";
import { trueForgeClient } from "./client.js";
import { ensureAgent, registerMcpServer, registerModelProvider } from "./setup.js";
import { TurnLog } from "./turn-log.js";

const PROMPT =
  "Inspect the current screen, then click the WhatsApp icon. Report what happened.";

async function main(): Promise<void> {
  console.log(`[1] TrueForge at ${config.trueforgeBaseUrl}`);
  const client = trueForgeClient();
  const capabilities = await client.server.getCapabilities();
  console.log(
    `    reachable. capabilities: ${JSON.stringify(capabilities.data).slice(0, 300)}`,
  );

  console.log("[2] Registering OpenCode Go model provider");
  await registerModelProvider();
  const models = await client.models.list();
  console.log(
    `    models now visible: ${models.data.map((m) => m.name).join(", ")}`,
  );

  console.log("[3] Starting fake Android MCP server");
  const fake = await startFakeDeviceMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
  });
  console.log(`    listening on ${fake.url}`);

  try {
    console.log("[4] Registering MCP server with TrueForge");
    await registerMcpServer(fake.url);

    console.log("[5] Ensuring agent exists");
    const agent = await ensureAgent();
    console.log(`    agent ready: ${agent.name}`);

    console.log("[6] Creating session and streaming turn");
    const session = await client.sessions.create({
      agent: { name: agent.name },
    });
    const sessionId = session.data.id;
    console.log(`    session ${sessionId}`);

    const log = new TurnLog();
    log.user(PROMPT);
    const stream = await client.sessions.createTurnStream(sessionId, {
      input: [{ type: "user.message", content: PROMPT }],
    });

    for await (const event of stream) {
      log.ingest(event as never);
    }

    log.summarize();

    const sawToolResult = log.hasToolResult();
    if (!sawToolResult) {
      throw new Error("Smoke criterion failed: no MCP tool result observed");
    }
    console.log("\nSMOKE OK: TrueForge loop verified (user -> model -> MCP tool -> result).");
  } finally {
    await fake.close();
  }
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

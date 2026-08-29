/**
 * Brief 02 step 0.2 — sandbox / Code Mode smoke test.
 *
 * Proves the runtime really hands the agent a sandbox before anything is built
 * on top of it: a throwaway agent with `config.sandbox.enabled` runs one turn
 * that can only be answered by executing Python, and we assert both that a
 * `sandbox.created` event appeared and that the arithmetic came back right.
 *
 * No provider registration is needed in standalone mode — the runtime's local
 * bubblewrap fallback engages automatically when no Daytona provider is
 * configured and the host probe passed at startup ("Local sandbox fallback is
 * available").
 *
 *   npm run -w @trueforge-android/server smoke:sandbox
 */
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { config } from "../config.js";
import { trueForgeClient } from "./client.js";
import { registerModelProvider, sandboxAvailable } from "./setup.js";

const PROMPT =
  "Use the sandbox to compute 6*7 in Python and print it. " +
  "Reply with just the number.";

async function main(): Promise<void> {
  console.log(`[0] sandboxAvailable() = ${sandboxAvailable()}`);
  console.log(`[1] TrueForge at ${config.trueforgeBaseUrl}`);
  const client = trueForgeClient();
  await client.server.getCapabilities();

  console.log("[2] Registering model provider");
  await registerModelProvider();

  const agentName = `${config.agentName}-sandbox-smoke`;
  console.log(`[3] Ensuring agent ${agentName} with sandbox enabled`);
  const manifest: TrueForgeApi.AgentSpec = {
    model: { name: `${config.modelProviderName}/${config.mainModelId}` },
    instructions:
      "You have a Python sandbox. Use it to compute anything the user asks for.",
    config: { iterationLimit: 10, sandbox: { enabled: true } },
  };
  try {
    await client.agents.create({ name: agentName, manifest });
  } catch {
    const listed = await client.agents.list();
    const existing = listed.data.find((agent) => agent.name === agentName);
    if (!existing) throw new Error(`Could not create or find agent ${agentName}`);
    await client.agents.update(existing.id, { manifest });
  }

  console.log("[4] Streaming one turn");
  const session = await client.sessions.create({ agent: { name: agentName } });
  const stream = await client.sessions.createTurnStream(session.data.id, {
    input: [{ type: "user.message", content: PROMPT }],
  });

  let sandboxCreated = false;
  let output = "";
  const seen = new Set<string>();
  for await (const event of stream) {
    const type = (event as { type?: string }).type ?? "unknown";
    seen.add(type);
    if (type === "sandbox.created") {
      sandboxCreated = true;
      console.log(`    ${JSON.stringify(event)}`);
    }
    if (type === "turn.done") {
      const state = (event as { state?: { output?: { content?: unknown } } }).state;
      output = String(state?.output?.content ?? "");
    }
  }

  console.log(`[5] event types: ${[...seen].sort().join(", ")}`);
  console.log(`    output: ${output.slice(0, 300)}`);
  if (!sandboxCreated) throw new Error("No sandbox.created event — Code Mode did not engage");
  if (!/\b42\b/.test(output)) throw new Error(`Sandbox answer wrong: ${output}`);
  console.log("\nSANDBOX SMOKE OK: sandbox.created observed and 6*7 = 42.");
}

main().catch((err) => {
  console.error("SANDBOX SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});

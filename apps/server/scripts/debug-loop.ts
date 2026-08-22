import { config } from "../src/config.js";
import { startFakeDeviceMcpServer } from "../src/mcp/fake-device.js";
import { trueForgeClient } from "../src/trueforge/client.js";
import {
  ensureAgent,
  registerMcpServer,
  registerModelProvider,
} from "../src/trueforge/setup.js";

async function main(): Promise<void> {
  const client = trueForgeClient();
  await registerModelProvider();

  const fake = await startFakeDeviceMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
    logRequests: true,
  });
  console.log(`fake listening on ${fake.url}`);

  // Probe reachability from this process first.
  const probe = await fetch(fake.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "debug", version: "0" },
      },
    }),
  });
  console.log("probe status:", probe.status);
  console.log("probe body:", (await probe.text()).slice(0, 300));

  try {
    await registerMcpServer(fake.url);
    const agent = await ensureAgent();
    const session = await client.sessions.create({ agent: { name: agent.name } });
    const stream = await client.sessions.createTurnStream(session.data.id, {
      input: [
        {
          type: "user.message",
          content: "Call get_test_screen once and report the packageName.",
        },
      ],
    });

    let lastEventId = "";
    for await (const event of stream) {
      if ("id" in event && typeof event.id === "string") lastEventId = event.id;
      if (event.type === "tool.response") {
        console.log("\n=== TOOL RESPONSE (full) ===");
        console.log(event.content);
        console.log("=== END ===\n");
      }
    }

    // Pull persisted events too, in case streaming dropped detail.
    const events = await client.sessions.listTurnEvents(session.data.id, "*", {
      order: "asc",
    });
    void events;
    void lastEventId;
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    await fake.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

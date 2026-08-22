/**
 * TrueForge Android bridge server entry point.
 *
 * Milestone 1: this process hosts the fake Android MCP tool server.
 * Milestone 3+: adds the WebSocket device gateway, MCP tool adapter backed by
 * real devices, TrueForge session routing, and event fanout.
 */
import { config } from "./config.js";
import { startFakeDeviceMcpServer } from "./mcp/fake-device.js";

async function main(): Promise<void> {
  console.log(`trueforge-android bridge starting (protocol v1)`);
  const fake = await startFakeDeviceMcpServer({
    host: config.mcpHost,
    port: config.mcpPort,
  });
  console.log(`fake device MCP endpoint: ${fake.url}`);

  const shutdown = async (): Promise<void> => {
    await fake.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

import { startFakeDeviceMcpServer } from "../src/mcp/fake-device.js";

async function main(): Promise<void> {
  const h = await startFakeDeviceMcpServer({ host: "127.0.0.1", port: 8792 });
  const init = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "curl", version: "0" },
    },
  };
  const res = await fetch("http://127.0.0.1:8792/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(init),
  });
  console.log("STATUS", res.status);
  console.log("HEADERS", Object.fromEntries(res.headers.entries()));
  console.log((await res.text()).slice(0, 800));
  await h.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

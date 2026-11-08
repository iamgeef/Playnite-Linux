#!/usr/bin/env node
// Local runnable entry point: `node bin.js [port]`
import { createHostedService } from "./src/server.js";

const port = Number.parseInt(process.argv[2] ?? "8787", 10);
const service = createHostedService();
const actualPort = await service.listen(port);

console.log(`Hosted service prototype listening on http://127.0.0.1:${actualPort}`);
console.log(`Web UI: http://127.0.0.1:${actualPort}/`);
console.log(`Helper WebSocket endpoint: ws://127.0.0.1:${actualPort}/helper`);
console.log("");
console.log("Create a pairing code:");
console.log(`  curl -s -X POST http://127.0.0.1:${actualPort}/api/pairing-codes`);
console.log("List paired devices:");
console.log(`  curl -s http://127.0.0.1:${actualPort}/api/devices`);
console.log("Automatically pair and start a helper on this machine:");
console.log("  cd linux-helper && node src/cli.js run-local");

process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await service.close();
    process.exit(0);
});

import { frontendServer } from "./lib/frontend-server.mjs";
const server = await frontendServer({ port: 4173 });
console.log("Local frontend test server ready");
process.on("SIGTERM", async () => { await server.close(); process.exit(0); });

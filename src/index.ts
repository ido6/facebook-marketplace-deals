#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { log } from "./log.js";

const { server, shutdown } = createServer();
await server.connect(new StdioServerTransport());
log.info("facebook-marketplace MCP server ready (stdio)");

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await shutdown().catch((e) => log.error(String(e)));
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.stdin.on("close", stop);

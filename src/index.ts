#!/usr/bin/env node
/**
 * autonomous-cinema-mcp — entry point.
 *
 * Starts the MCP server over stdio. Run directly (`node dist/index.js`) or via
 * the `autonomous-cinema-mcp` bin, and register it in an MCP client such as
 * Claude Desktop (see README).
 */
import { startStdioServer } from "./server.js";
import { log } from "./logger.js";

startStdioServer().catch((err) => {
  log.error("Fatal: failed to start server", String(err));
  process.exit(1);
});

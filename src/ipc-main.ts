#!/usr/bin/env node
/**
 * Standalone entry for the localhost IPC REST API (`npm run ipc`).
 *
 * The MCP tool `ipc_start` only lives as long as its MCP session; companion
 * tools (devuniverse-mcp's generate_media_asset) need a long-running service.
 * This starts the same server, prints where it listens and where the bearer
 * token is stored, and keeps running until SIGINT/SIGTERM.
 */
import { ensureDirs, paths } from "./config.js";
import { ipcServer } from "./api/ipc-protocol.js";

ensureDirs();
const portArg = process.argv.indexOf("--port");
const port = portArg > -1 ? Number.parseInt(process.argv[portArg + 1] ?? "", 10) : undefined;
const info = await ipcServer.start(Number.isFinite(port) ? port : undefined);
process.stdout.write(
  `omnicinema IPC listening on ${info.url}\n` +
  `bearer token file: ${paths.ipcToken}\n` +
  `health: curl ${info.url}/health\n`,
);
const stop = async (): Promise<void> => { await ipcServer.stop(); process.exit(0); };
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

/**
 * Logger that writes to stderr ONLY.
 *
 * The MCP stdio transport uses stdout for protocol frames. Writing logs to
 * stdout would corrupt the JSON-RPC stream, so every diagnostic goes to stderr.
 */
type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.CINEMA_LOG_LEVEL as Level) || "info"] ?? order.info;

function emit(level: Level, msg: string, extra?: unknown): void {
  if (order[level] < threshold) return;
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [omnicinema-mcp]`;
  if (extra !== undefined) {
    process.stderr.write(`${prefix} ${msg} ${safeJson(extra)}\n`);
  } else {
    process.stderr.write(`${prefix} ${msg}\n`);
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit("debug", msg, extra),
  info: (msg: string, extra?: unknown) => emit("info", msg, extra),
  warn: (msg: string, extra?: unknown) => emit("warn", msg, extra),
  error: (msg: string, extra?: unknown) => emit("error", msg, extra),
};

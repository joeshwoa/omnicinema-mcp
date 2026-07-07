/**
 * Small HTTP helpers built on the global fetch (Node >= 18). Every request has a
 * timeout and a descriptive User-Agent so remote services can identify the tool.
 */
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { log } from "./logger.js";

export const USER_AGENT = "omnicinema-mcp/0.2 (+https://github.com/)";

export async function getJson<T>(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 30_000,
): Promise<T> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${redact(url)} -> HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/** Stream a remote asset to a local file path. Returns bytes written. */
export async function downloadTo(
  url: string,
  destPath: string,
  headers: Record<string, string> = {},
  timeoutMs = 120_000,
): Promise<number> {
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download ${redact(url)} -> HTTP ${res.status} ${res.statusText}`);
  }
  const nodeStream = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(nodeStream, fs.createWriteStream(destPath));
  const { size } = fs.statSync(destPath);
  log.debug(`Downloaded ${size} bytes -> ${destPath}`);
  return size;
}

/** Fire-and-forget GET (used for Unsplash download-tracking compliance). */
export async function ping(url: string, headers: Record<string, string> = {}): Promise<void> {
  try {
    await fetch(url, {
      headers: { "user-agent": USER_AGENT, ...headers },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* non-fatal */
  }
}

/** Hide query-string secrets (api keys) from logs/errors. */
function redact(url: string): string {
  return url.replace(/([?&](key|api_key|apikey|access_key)=)[^&]+/gi, "$1***");
}

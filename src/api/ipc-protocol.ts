/**
 * Inter-Tool Programming Protocol.
 *
 * A localhost-only REST API that lets another local tool (e.g. a future
 * programming MCP) introspect this engine's schema and request assets
 * programmatically. Security posture:
 *   - binds to 127.0.0.1 by default (never 0.0.0.0 unless explicitly overridden),
 *   - requires a bearer token (generated + stored in data/ipc-token.txt, 0600),
 *   - no CORS headers, so a browser page cannot read responses cross-origin,
 *   - never executes arbitrary code — it only serves metadata and drives the
 *     existing, budget-guarded engines,
 *   - the budget guard still applies: over-budget requests return HTTP 402 with a
 *     cost breakdown instead of silently spending a free quota.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { env, paths } from "../config.js";
import { log } from "../logger.js";
import { describeProviders } from "../providers/registry.js";
import { getStatus } from "../limits/limit-manager.js";
import { generateImageAsset } from "../pipeline/image-engine.js";
import { generateSoundtrack, generateVoiceover, generateSfx } from "../pipeline/audio-engine.js";
import { consult, PERSONAS } from "../personas/consultation.js";
import { isHalt } from "../pipeline/asset-results.js";
import type { AssetKind } from "../personas/types.js";

const TRACKED_PROVIDERS = [
  "huggingface", "replicate", "fal", "pexels", "pixabay", "unsplash", "freesound",
  "huggingface-image", "replicate-image", "huggingface-tts", "huggingface-music", "replicate-music",
];

export function getOrCreateToken(): string {
  const fromEnv = env.ipcToken();
  if (fromEnv) return fromEnv;
  try {
    const existing = fs.readFileSync(paths.ipcToken, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* create below */
  }
  const token = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(paths.data, { recursive: true });
  fs.writeFileSync(paths.ipcToken, token, { mode: 0o600 });
  return token;
}

export function buildSchema(): Record<string, unknown> {
  return {
    name: "omnicinema-mcp",
    version: "0.2.0",
    description: "Programmatic asset-creation API. Authenticate with 'Authorization: Bearer <token>'.",
    auth: { type: "bearer", header: "Authorization" },
    personas: PERSONAS.map((p) => ({ id: p.id, title: p.title, leads: p.leads, advises: p.advises })),
    providers: describeProviders().map((p) => ({ slug: p.slug, category: p.category, configured: p.configured })),
    assetKinds: ["cinematic-photo", "logo", "vector-art", "texture", "ui-mockup", "voiceover", "soundtrack", "sfx"],
    endpoints: [
      { method: "GET", path: "/health", auth: false, returns: "service status" },
      { method: "GET", path: "/schema", auth: true, returns: "this document" },
      { method: "GET", path: "/limits", auth: true, returns: "per-provider free-tier usage" },
      { method: "POST", path: "/consult", auth: true, body: { assetKind: "AssetKind", subject: "string", style: "string?" }, returns: "compiled PromptBrief (no generation)" },
      { method: "POST", path: "/assets/image", auth: true, body: { assetKind: "cinematic-photo|logo|vector-art|texture|ui-mockup", subject: "string", style: "string?", generative: "boolean?", approveOverBudget: "boolean?" }, returns: "GeneratedAsset | BudgetHalt(402)" },
      { method: "POST", path: "/assets/audio", auth: true, body: { type: "voiceover|soundtrack|sfx", subject: "string", script: "string?", style: "string?", generative: "boolean?", approveOverBudget: "boolean?" }, returns: "GeneratedAsset | BudgetHalt(402)" },
    ],
    budget: { note: "Requests that would exceed a free quota return HTTP 402 with a breakdown; retry with approveOverBudget:true to proceed." },
  };
}

export interface IpcInfo {
  url: string;
  token: string;
  host: string;
  port: number;
}

export class CinemaIpcServer {
  private server: http.Server | null = null;
  private token = "";
  private host = "127.0.0.1";
  private port = 8787;

  get info(): IpcInfo {
    return { url: `http://${this.host}:${this.port}`, token: this.token, host: this.host, port: this.port };
  }

  get running(): boolean {
    return this.server !== null && this.server.listening;
  }

  async start(overridePort?: number): Promise<IpcInfo> {
    if (this.running) return this.info;
    this.token = getOrCreateToken();
    this.host = env.ipcHost();
    this.port = overridePort ?? env.ipcPort();
    if (this.host !== "127.0.0.1" && this.host !== "localhost") {
      log.warn(`IPC host is "${this.host}" (not localhost). Ensure this is intentional and firewalled.`);
    }

    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, this.host, () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.port = addr.port; // resolve ephemeral (:0)
        resolve();
      });
    });
    log.info(`IPC server listening on ${this.info.url}`);
    return this.info;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private authed(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (!provided || provided.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(this.token));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", `http://${this.host}:${this.port}`);
      const route = `${req.method} ${url.pathname}`;

      if (route === "GET /health") {
        return json(res, 200, { ok: true, name: "omnicinema-mcp", version: "0.2.0", uptime: process.uptime() });
      }

      if (!this.authed(req)) {
        return json(res, 401, { error: "unauthorized", hint: "send 'Authorization: Bearer <token>'" });
      }

      if (route === "GET /schema") return json(res, 200, buildSchema());

      if (route === "GET /limits") {
        const providers = TRACKED_PROVIDERS.map((p) => getStatus(p));
        return json(res, 200, { providers });
      }

      if (req.method === "POST") {
        const body = await readJson(req);
        if (body === null) return json(res, 400, { error: "invalid or oversized JSON body" });
        if (url.pathname === "/consult") return this.consult(res, body);
        if (url.pathname === "/assets/image") return this.image(res, body);
        if (url.pathname === "/assets/audio") return this.audio(res, body);
      }

      return json(res, 404, { error: "not found", route });
    } catch (err) {
      log.error("IPC handler error", String(err));
      return json(res, 500, { error: String(err) });
    }
  }

  private consult(res: http.ServerResponse, body: Record<string, unknown>): void {
    const assetKind = body.assetKind as AssetKind;
    if (!assetKind || !body.subject) return json(res, 400, { error: "assetKind and subject are required" });
    const brief = consult({ assetKind, subject: String(body.subject), style: body.style ? String(body.style) : undefined });
    json(res, 200, { brief });
  }

  private async image(res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    if (!body.assetKind || !body.subject) return json(res, 400, { error: "assetKind and subject are required" });
    const result = await generateImageAsset({
      assetKind: body.assetKind as AssetKind,
      subject: String(body.subject),
      style: body.style ? String(body.style) : undefined,
      generative: Boolean(body.generative),
      approveOverBudget: Boolean(body.approveOverBudget),
    });
    if (isHalt(result)) return json(res, 402, result);
    json(res, 200, result);
  }

  private async audio(res: http.ServerResponse, body: Record<string, unknown>): Promise<void> {
    const type = String(body.type ?? "");
    if (!body.subject) return json(res, 400, { error: "subject is required" });
    const input = {
      assetKind: (type === "voiceover" ? "voiceover" : type === "sfx" ? "sfx" : "soundtrack") as AssetKind,
      subject: String(body.subject),
      script: body.script ? String(body.script) : undefined,
      style: body.style ? String(body.style) : undefined,
      generative: Boolean(body.generative),
      approveOverBudget: Boolean(body.approveOverBudget),
    };
    const result =
      type === "voiceover" ? await generateVoiceover(input)
      : type === "sfx" ? await generateSfx(input)
      : await generateSoundtrack(input);
    if (isHalt(result)) return json(res, 402, result);
    json(res, 200, result);
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 256 * 1024;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

/** Module-level singleton so MCP tools can start/inspect one shared server. */
export const ipcServer = new CinemaIpcServer();

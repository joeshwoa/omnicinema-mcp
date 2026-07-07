/**
 * MCP server definition. Exposes the cinema pipeline as Model Context Protocol
 * tools over stdio. All tool handlers are wrapped so a thrown error becomes a
 * structured `isError` result instead of crashing the server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log } from "./logger.js";
import { runCinemaPipeline, compileMontage } from "./pipeline/runCinemaPipeline.js";
import { configuredStockProviders } from "./assets/stockManager.js";
import { describeProviders } from "./providers/registry.js";
import { discover, approveSuggestion, listSuggestions } from "./discovery/discover.js";
import { installDependencies } from "./installer/systemInstaller.js";
import { consult, transcriptLines } from "./personas/consultation.js";
import { generateImageAsset } from "./pipeline/image-engine.js";
import { generateVoiceover, generateSoundtrack, generateSfx } from "./pipeline/audio-engine.js";
import { isHalt, type EngineResult } from "./pipeline/asset-results.js";
import { getStatus } from "./limits/limit-manager.js";
import { ipcServer } from "./api/ipc-protocol.js";
import type { AssetKind } from "./personas/types.js";
import type { PipelineReport } from "./types.js";

const TRACKED_LIMIT_PROVIDERS = [
  "huggingface", "replicate", "fal", "pexels", "pixabay", "unsplash", "freesound",
  "huggingface-image", "replicate-image", "huggingface-tts", "huggingface-music", "replicate-music",
];

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(obj: unknown, summary?: string): TextResult {
  const json = JSON.stringify(obj, null, 2);
  const text = summary ? `${summary}\n\n\`\`\`json\n${json}\n\`\`\`` : json;
  return { content: [{ type: "text", text }] };
}

function err(message: string): TextResult {
  return { content: [{ type: "text", text: `ERROR: ${message}` }], isError: true };
}

async function guard(fn: () => Promise<TextResult>): Promise<TextResult> {
  try {
    return await fn();
  } catch (e) {
    log.error("Tool handler failed", String(e));
    return err(e instanceof Error ? e.message : String(e));
  }
}

function summarizeReport(r: PipelineReport): string {
  const lines = [
    `🎬 ${r.title}`,
    r.logline,
    `Project: ${r.projectId}`,
    `Location: ${r.projectPath}`,
    `Scenes: ${r.sceneCount} · Shots: ${r.shotCount} · Assets: ${r.assets.total} (${Object.entries(r.assets.bySource).map(([k, v]) => `${k}:${v}`).join(", ") || "none"})`,
    `Screenplay: ${r.screenplayPath}`,
    `Timeline: ${r.timelinePath}`,
    r.renderedVideoPath ? `✅ Rendered: ${r.renderedVideoPath}` : `Rendered: not yet`,
    r.paused ? "⏸️  Paused for interactive montage." : "",
    r.warnings.length ? `⚠️  ${r.warnings.length} warning(s).` : "No warnings.",
    r.nextSteps.length ? `Next steps:\n- ${r.nextSteps.join("\n- ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

function engineResult(r: EngineResult): TextResult {
  if (isHalt(r)) {
    const text =
      `⛔ BUDGET GATE — approval required before spending a free quota.\n` +
      `${r.reason}\n\nCost breakdown:\n${r.breakdown.join("\n")}\n\n` +
      `Re-run the same tool with approveOverBudget:true to proceed.`;
    return ok(r, text);
  }
  const summary =
    `✅ ${r.kind} via ${r.provider} (${r.source})\n` +
    `File: ${r.path}\n` +
    (r.durationMs ? `Duration: ${r.durationMs} ms\n` : "") +
    (r.width ? `Size: ${r.width}×${r.height}\n` : "") +
    `License: ${r.license}\n` +
    `Lead persona: ${r.brief.leadPersona}` +
    (r.warnings.length ? `\n⚠ ${r.warnings.join("; ")}` : "");
  return ok(r, summary);
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "omnicinema-mcp",
    version: "0.2.0",
  });

  server.registerTool(
    "run_cinema_pipeline",
    {
      title: "Run Cinema Pipeline",
      description:
        "Generate a multi-scene screenplay with shot-to-shot frame continuity, acquire " +
        "matching footage (official stock APIs, or opt-in bring-your-own-key generative " +
        "providers, or generated placeholders), assemble a frame-accurate Remotion timeline, " +
        "validate it (no missing assets, no gaps/overlaps), and optionally render an MP4. " +
        "Use workflow_mode='interactive_montage' to pause after asset acquisition so a human " +
        "can arrange clips before compiling.",
      inputSchema: {
        prompt: z.string().min(1).describe("The video concept description."),
        workflow_mode: z
          .enum(["fully_automated", "interactive_montage"])
          .default("fully_automated")
          .describe("fully_automated runs end-to-end; interactive_montage pauses post-download to let the user organize clips before compiling."),
        sceneCount: z.number().int().min(1).max(12).optional().describe("Number of scenes (default derived from the prompt)."),
        shotsPerScene: z.number().int().min(1).max(6).optional().describe("Shots per scene (default 2)."),
        shotDurationSeconds: z.number().min(1).max(30).optional().describe("Seconds per shot (default 4)."),
        fps: z.number().int().min(1).max(120).optional().describe("Frames per second (default 30)."),
        width: z.number().int().min(16).max(7680).optional().describe("Frame width (default 1920)."),
        height: z.number().int().min(16).max(4320).optional().describe("Frame height (default 1080)."),
        style: z.string().optional().describe("Visual style, e.g. 'noir', 'documentary', 'neon cyberpunk'."),
        prefer: z.enum(["video", "image"]).optional().describe("Prefer motion b-roll ('video') or stills ('image')."),
        generative: z.boolean().optional().describe("Opt in to bring-your-own-key generative video providers (default false)."),
        render: z.boolean().optional().describe("Render the MP4 now if Remotion is installed (default true in fully_automated mode)."),
        narration: z.string().optional().describe("Optional narration script; generated offline and locked to the timeline as a voiceover track."),
        soundtrack: z.boolean().optional().describe("Add an offline-synthesized soundtrack bed locked to the timeline."),
        musicStyle: z.string().optional().describe("Genre/style for the soundtrack, e.g. 'lo-fi', 'cinematic orchestral', 'hip-hop'."),
      },
    },
    async (args) =>
      guard(async () => {
        const report = await runCinemaPipeline(args);
        return ok(report, summarizeReport(report));
      }),
  );

  server.registerTool(
    "compile_montage",
    {
      title: "Compile Montage",
      description:
        "Resume an interactive project: (re)build the timeline from the project directory " +
        "(honoring an optional montage-order.json), validate it, and render the final video.",
      inputSchema: {
        projectId: z.string().min(1).describe("The projectId returned by run_cinema_pipeline."),
        render: z.boolean().optional().describe("Render after compiling (default true)."),
      },
    },
    async (args) =>
      guard(async () => {
        const report = await compileMontage(args.projectId, { render: args.render });
        return ok(report, summarizeReport(report));
      }),
  );

  server.registerTool(
    "install_dependencies",
    {
      title: "Install Local Dependencies",
      description:
        "Detect the host OS and install missing multimedia dependencies (Remotion packages, " +
        "ffmpeg, Blender) using the platform package manager. Requires explicit consent: with " +
        "consent=false it returns the exact commands it would run and the permission prompt, and " +
        "installs nothing. Caches are pointed at the external volume.",
      inputSchema: {
        consent: z.boolean().default(false).describe("Set true to actually run the installation commands."),
        targets: z.array(z.enum(["remotion", "ffmpeg", "blender"])).optional().describe("Which dependencies to install (default all)."),
      },
    },
    async (args) =>
      guard(async () => {
        const report = await installDependencies({ consent: args.consent, targets: args.targets });
        const summary = report.executed
          ? "Installation executed. See results below."
          : `Consent required. ${report.consentPrompt}\n\nCommands that WOULD run:\n- ${report.plannedCommands.join("\n- ") || "(nothing missing)"}`;
        return ok(report, summary);
      }),
  );

  server.registerTool(
    "list_providers",
    {
      title: "List Providers",
      description: "List the curated asset/generative providers from tools-registry.json with their live configured status.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const providers = describeProviders();
        const stock = configuredStockProviders();
        return ok({ stockConfigured: stock, providers }, `Providers: ${providers.length} catalogued · stock configured: ${stock.join(", ") || "none"}`);
      }),
  );

  server.registerTool(
    "discover_providers",
    {
      title: "Discover Providers (review-only)",
      description:
        "Scan official public catalogs (Hugging Face Hub, GitHub Search) for candidate video " +
        "tools and append them to discovery-suggestions.json for human review. Never auto-integrates " +
        "or executes anything found — promotion into the active registry is a separate, explicit step.",
      inputSchema: {
        query: z.string().min(1).describe("Search term, e.g. 'text to video' or 'seedance'."),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await discover(args.query);
        const top = result.suggestions.slice(0, 5).map((s) => `  • [${s.source}] ${s.id} (★${s.signal}) — ${s.url}`);
        const alert =
          `🔔 ADDON REVIEW ALERT — ${result.added} new suggestion(s) queued (${result.total} awaiting review).\n` +
          `Nothing was activated. Review data/review-queue.json, then call approve_suggestion(suggestionId, approve:true).\n` +
          (top.length ? `\nTop candidates:\n${top.join("\n")}` : "");
        return ok(result, alert);
      }),
  );

  server.registerTool(
    "approve_suggestion",
    {
      title: "Approve Discovered Suggestion",
      description:
        "Explicitly promote a reviewed discovery suggestion into tools-registry.json. Added DISABLED " +
        "and unimplemented — a human must write an adapter and enable it before use. Requires approve=true.",
      inputSchema: {
        suggestionId: z.string().min(1).describe("The suggestion id (from discover_providers / listing)."),
        approve: z.boolean().default(false).describe("Must be true to make any change."),
      },
    },
    async (args) =>
      guard(async () => {
        const result = approveSuggestion(args.suggestionId, args.approve);
        return ok({ ...result, pending: listSuggestions().filter((s) => s.status === "needs_review").length }, result.message);
      }),
  );

  server.registerTool(
    "consult_personas",
    {
      title: "Consult Design Personas",
      description:
        "Run the multi-agent persona consultation for an asset kind and return the compiled " +
        "PromptBrief (positive + negative prompt, technical params, and the debate transcript) " +
        "WITHOUT generating anything. Use to preview/tune the prompt strategy first.",
      inputSchema: {
        assetKind: z.enum(["cinematic-photo", "logo", "vector-art", "texture", "ui-mockup", "voiceover", "soundtrack", "sfx"]).describe("What to design."),
        subject: z.string().min(1).describe("The subject/description."),
        style: z.string().optional().describe("Style hint, e.g. 'noir', 'lo-fi', 'brutalist'."),
        aspectRatio: z.string().optional().describe("e.g. '16:9', '1:1', '9:16'."),
      },
    },
    async (args) =>
      guard(async () => {
        const brief = consult(args);
        return ok(brief, `🎯 ${brief.leadPersona} leads (advisors: ${brief.advisors.join(", ") || "none"}).\n\nStrategy:\n- ${transcriptLines(brief).join("\n- ")}\n\nPrompt: ${brief.positivePrompt}`);
      }),
  );

  server.registerTool(
    "generate_image",
    {
      title: "Generate Image / Design Asset",
      description:
        "Create a cinematic photo, transparent logo, vector art, texture, or UI mockup. Vector kinds " +
        "render as real SVG offline; photoreal kinds use a configured image API when generative=true, " +
        "else a local placeholder. Budget-guarded: an over-quota request returns a halt with a cost " +
        "breakdown — retry with approveOverBudget:true.",
      inputSchema: {
        assetKind: z.enum(["cinematic-photo", "logo", "vector-art", "texture", "ui-mockup"]).describe("Type of visual asset."),
        subject: z.string().min(1).describe("What to create."),
        style: z.string().optional(),
        aspectRatio: z.string().optional(),
        generative: z.boolean().optional().describe("Use an official image API (needs a configured key)."),
        approveOverBudget: z.boolean().optional().describe("Proceed even if the budget guard flags the request."),
      },
    },
    async (args) => guard(async () => engineResult(await generateImageAsset(args))),
  );

  server.registerTool(
    "generate_voiceover",
    {
      title: "Generate Voiceover",
      description:
        "Generate spoken narration. Uses a configured TTS API when generative=true, else a local " +
        "placeholder. Returns a precise millisecond duration for the sequencer. Budget-guarded.",
      inputSchema: {
        subject: z.string().min(1).describe("Topic or the narration script itself."),
        script: z.string().optional().describe("Explicit script (overrides subject as the spoken text)."),
        style: z.string().optional().describe("e.g. 'dramatic', 'calm documentary', 'energetic'."),
        generative: z.boolean().optional(),
        approveOverBudget: z.boolean().optional(),
      },
    },
    async (args) => guard(async () => engineResult(await generateVoiceover({ ...args, assetKind: "voiceover" }))),
  );

  server.registerTool(
    "generate_soundtrack",
    {
      title: "Generate Soundtrack / Music",
      description:
        "Compose a full instrumental across genres (hip-hop, rap, cinematic orchestral, rock, lo-fi, " +
        "electronic). The Music Producer persona plans BPM/key/structure/instrumentation. Renders via a " +
        "configured MusicGen API when generative=true, else deterministic local synthesis (WAV + editable " +
        "MIDI). Returns exact duration. Budget-guarded.",
      inputSchema: {
        subject: z.string().min(1).describe("Theme/mood, e.g. 'rainy midnight city'."),
        style: z.string().optional().describe("Genre, e.g. 'hip-hop', 'cinematic orchestral', 'lo-fi', 'electronic'."),
        generative: z.boolean().optional(),
        approveOverBudget: z.boolean().optional(),
      },
    },
    async (args) => guard(async () => engineResult(await generateSoundtrack({ ...args, assetKind: "soundtrack" }))),
  );

  server.registerTool(
    "generate_sfx",
    {
      title: "Generate Sound Effect",
      description:
        "Produce a sound effect / ambience. Uses the Freesound API when generative=true, else a local " +
        "synthesized transient. Returns exact duration. Budget-guarded.",
      inputSchema: {
        subject: z.string().min(1).describe("The effect, e.g. 'whoosh transition', 'rain ambience'."),
        style: z.string().optional(),
        generative: z.boolean().optional(),
        approveOverBudget: z.boolean().optional(),
      },
    },
    async (args) => guard(async () => engineResult(await generateSfx({ ...args, assetKind: "sfx" }))),
  );

  server.registerTool(
    "check_limits",
    {
      title: "Check Free-Tier Usage",
      description: "Report per-provider free-tier usage from data/usage-limits.json (daily/weekly/monthly).",
      inputSchema: {
        provider: z.string().optional().describe("A single provider slug; omit for all tracked providers."),
      },
    },
    async (args) =>
      guard(async () => {
        const providers = args.provider ? [args.provider] : TRACKED_LIMIT_PROVIDERS;
        const statuses = providers.map((p) => getStatus(p));
        return ok({ providers: statuses }, `Usage for ${statuses.length} provider(s). Guard rails halt over-quota generative calls unless approved.`);
      }),
  );

  server.registerTool(
    "ipc_start",
    {
      title: "Start Inter-Tool IPC Server",
      description:
        "Start the localhost-only REST API so another local tool can request assets programmatically. " +
        "Returns the base URL and bearer token. Bound to 127.0.0.1; token stored in data/ipc-token.txt.",
      inputSchema: {
        port: z.number().int().min(0).max(65535).optional().describe("Port (default from OMNICINEMA_IPC_PORT / 8787)."),
      },
    },
    async (args) =>
      guard(async () => {
        const info = await ipcServer.start(args.port);
        return ok(info, `🔌 IPC server on ${info.url}\nBearer token: ${info.token}\nGET ${info.url}/schema for the metadata contract.`);
      }),
  );

  server.registerTool(
    "ipc_status",
    {
      title: "IPC Server Status",
      description: "Report whether the inter-tool IPC server is running and its address.",
      inputSchema: {},
    },
    async () => guard(async () => ok({ running: ipcServer.running, ...(ipcServer.running ? ipcServer.info : {}) }, ipcServer.running ? `Running on ${ipcServer.info.url}` : "IPC server is not running.")),
  );

  server.registerTool(
    "ipc_stop",
    {
      title: "Stop IPC Server",
      description: "Stop the inter-tool IPC server if running.",
      inputSchema: {},
    },
    async () => guard(async () => { await ipcServer.stop(); return ok({ running: false }, "IPC server stopped."); }),
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("autonomous-cinema-mcp server started on stdio.");
}

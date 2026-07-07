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
import type { PipelineReport } from "./types.js";

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

export function createServer(): McpServer {
  const server = new McpServer({
    name: "autonomous-cinema-mcp",
    version: "0.1.0",
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
        return ok(result, `Discovery added ${result.added} new suggestion(s); ${result.total} total await review. Nothing was activated.`);
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

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("autonomous-cinema-mcp server started on stdio.");
}

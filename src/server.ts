/**
 * MCP server definition. Exposes the asset engine as Model Context Protocol
 * tools over stdio. Every handler is wrapped so a thrown error becomes a
 * structured `isError` result instead of crashing the server, and every text
 * result ends with the output file paths and concrete next steps.
 *
 * Safety boundaries (unchanged): network/paid/installing actions only happen
 * behind explicit flags (`generative`, `approveOverBudget`, `consent`,
 * `approve`), the budget guard gates free quotas, and discovery never
 * integrates anything by itself.
 */
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { log } from "./logger.js";
import { paths } from "./config.js";
import { runCinemaPipeline, compileMontage, planCinemaPipeline, type PipelinePlan } from "./pipeline/runCinemaPipeline.js";
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
import type { PipelineReport } from "./types.js";

export const VERSION = "0.3.0";

const TRACKED_LIMIT_PROVIDERS = [
  "huggingface", "replicate", "fal", "pexels", "pixabay", "unsplash", "freesound",
  "huggingface-image", "replicate-image", "huggingface-tts", "huggingface-music", "replicate-music",
];

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Summary → Files → Next steps, then the full JSON for programmatic use. */
function ok(obj: unknown, summary: string, files: string[] = [], next: string[] = []): TextResult {
  const parts = [summary.trim()];
  const f = files.filter(Boolean);
  if (f.length) parts.push(`Files:\n${f.map((p) => `- ${p}`).join("\n")}`);
  if (next.length) parts.push(`Next steps:\n${next.map((s) => `- ${s}`).join("\n")}`);
  parts.push("```json\n" + JSON.stringify(obj, null, 2) + "\n```");
  return { content: [{ type: "text", text: parts.join("\n\n") }] };
}

function err(message: string): TextResult {
  return { content: [{ type: "text", text: `ERROR: ${message}\n\nNext steps:\n- Check the arguments against the tool description; call list_providers to see what is configured.` }], isError: true };
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
    `${r.title}`,
    r.logline,
    `Project: ${r.projectId}`,
    `Scenes: ${r.sceneCount} · Shots: ${r.shotCount} · Length: ${r.durationSeconds ?? "?"}s · Assets: ${r.assets.total} (${Object.entries(r.assets.bySource).map(([k, v]) => `${k}:${v}`).join(", ") || "none"})`,
    r.renderedVideoPath ? `Rendered with ${r.renderEngine ?? "?"}: ${r.renderedVideoPath}` : `Rendered: not yet`,
    r.paused ? "Paused for interactive montage." : "",
    r.warnings.length ? `Warnings (${r.warnings.length}):\n- ${r.warnings.slice(0, 8).join("\n- ")}${r.warnings.length > 8 ? "\n- …" : ""}` : "No warnings.",
  ];
  return lines.filter(Boolean).join("\n");
}

function reportFiles(r: PipelineReport): string[] {
  return [r.renderedVideoPath ?? "", r.screenplayPath, r.timelinePath, `${r.projectPath}/attributions.txt`, `${r.projectPath}/manifest.json`, ...(r.audio ?? []).map((a) => `${r.projectPath}/${a.src}`)];
}

function summarizePlan(p: PipelinePlan): string {
  const shots = p.scenes.flatMap((s, i) => [
    `${i + 1}. ${s.heading}${s.beat ? ` [${s.beat}]` : ""} — ${s.summary}`,
    ...s.shots.map((sh) => `   · ${sh.id} (${sh.type ?? "shot"}, ${sh.seconds}s, ${sh.camera}): ${sh.action}  ⟶ search "${sh.query}"`),
  ]);
  return [
    `DRY RUN — nothing was generated, downloaded or written.`,
    `${p.title} · ${p.format} · ${p.totalSeconds}s`,
    p.logline,
    "",
    ...shots,
    "",
    `Footage: ${p.assets.stockProviders.length ? `stock via ${p.assets.stockProviders.join(", ")}` : "no stock key configured"}; fallback: ${p.assets.fallback}.`,
    `Generative video: ${p.assets.generative.requested ? (p.assets.generative.configured.length ? `${p.assets.generative.configured.join(" → ")} (${p.assets.generative.unitsPerProvider} units)` : "requested but not configured") : "off"}.`,
    `Audio: narration ${p.audio.narration ? `~${p.audio.estimatedNarrationSeconds}s via ${p.audio.tts}` : "none"}; soundtrack ${p.audio.soundtrack ?? "none"}.`,
    `Render: ${p.render.willRender ? p.render.engine : p.render.engine ? "skipped (render:false or interactive)" : "no engine available"}.`,
    `Network: ${p.network.join(" ")}`,
    `Spend: ${p.spend.join(" ")}`,
  ].join("\n");
}

function engineResult(r: EngineResult, extraNext: string[] = []): TextResult {
  if (isHalt(r)) {
    const text =
      `BUDGET GATE — nothing was generated and no quota was used.\n` +
      `${r.reason}\n\nCost breakdown:\n${r.breakdown.join("\n")}`;
    return ok(r, text, [], [
      "Ask the user whether to spend this quota. If yes, call the same tool again with approveOverBudget:true.",
      "Or call it without generative:true for the free offline version.",
    ]);
  }
  const meta = (r.meta ?? {}) as Record<string, unknown>;
  const variants = (meta.variants ?? {}) as Record<string, string>;
  const files = [r.path, typeof meta.pngPath === "string" ? meta.pngPath : "", ...Object.values(variants), typeof meta.midiPath === "string" ? meta.midiPath : ""];
  const summary =
    `${r.kind} via ${r.provider} (${r.source === "offline" ? "offline, no network" : "API"})\n` +
    (r.durationMs ? `Duration: ${(r.durationMs / 1000).toFixed(2)} s (${r.durationMs} ms)\n` : "") +
    (r.width ? `Size: ${r.width}×${r.height}\n` : "") +
    (Array.isArray(meta.design) && meta.design.length ? `Design: ${(meta.design as string[]).join(", ")}\n` : "") +
    `License: ${r.license}\n` +
    `Lead persona: ${r.brief.leadPersona}` +
    (r.warnings.length ? `\nNotes:\n- ${r.warnings.join("\n- ")}` : "");
  const next = [...extraNext];
  if (r.source === "offline" && r.kind !== "logo" && r.kind !== "vector-art" && r.kind !== "ui-mockup" && r.kind !== "sfx" && r.kind !== "soundtrack") {
    next.push("This is the offline version. For an API-generated one, configure the provider key (see list_providers) and call again with generative:true — that uses your quota.");
  }
  next.push("Use consult_personas with the same subject/style to see and tune the prompt strategy.");
  return ok(r, summary, files, next);
}

const ASSET_KINDS = ["cinematic-photo", "logo", "vector-art", "texture", "ui-mockup", "voiceover", "soundtrack", "sfx"] as const;

export function createServer(): McpServer {
  const server = new McpServer({ name: "omnicinema-mcp", version: VERSION });

  server.registerTool(
    "run_cinema_pipeline",
    {
      title: "Make a Short Video (screenplay → footage → edit → MP4)",
      description:
        "Use when the user wants a short video from a one-line idea. Writes a multi-scene screenplay with shot-to-shot " +
        "continuity, fills each shot with stock footage (Pexels/Pixabay/Unsplash, only if their keys are set) or an " +
        "offline storyboard frame, optionally adds narration (offline system TTS + captions) and a soundtrack fitted " +
        "to the cut, edits a frame-accurate timeline (hard cuts in a scene, dissolves between scenes) and renders an MP4 " +
        "with Remotion or ffmpeg.\n" +
        "TIP: call with dry_run:true first — it returns the screenplay, shot list, provider choice and a cost/network " +
        "estimate instantly without writing files, so you can show the user before producing.\n" +
        "Network/money: stock APIs are used automatically when keys exist (free; set stock:false to stay offline). " +
        "generative:true calls paid-or-quota video APIs (budget-guarded; approveOverBudget:true to exceed). With no keys " +
        "everything runs offline.\n" +
        "Returns: projectId, rendered MP4 path (if rendered), screenplay.md, timeline.json, attributions, warnings, next steps. " +
        "interactive_montage pauses before the edit so a human can reorder/replace clips, then compile_montage finishes.",
      inputSchema: {
        prompt: z.string().min(1).describe("The video idea, e.g. 'a lone lighthouse keeper watching a storm roll in'."),
        dry_run: z.boolean().optional().describe("true = plan only: screenplay, shot list, providers, cost estimate. No files, no network, no quota."),
        workflow_mode: z.enum(["fully_automated", "interactive_montage"]).default("fully_automated").describe("fully_automated renders in one call; interactive_montage stops after gathering clips (then use compile_montage)."),
        sceneCount: z.number().int().min(1).max(12).optional().describe("Number of scenes (default 3–5 from the prompt). Scenes follow a story arc."),
        shotsPerScene: z.number().int().min(1).max(6).optional().describe("Shots per scene (default 2): establishing → medium → close."),
        shotDurationSeconds: z.number().min(1).max(30).optional().describe("Seconds per shot (default 4)."),
        fps: z.number().int().min(1).max(120).optional().describe("Frames per second (default 30)."),
        width: z.number().int().min(16).max(7680).optional().describe("Frame width (default 1920). Use 1080 with height 1920 for vertical."),
        height: z.number().int().min(16).max(4320).optional().describe("Frame height (default 1080)."),
        style: z.string().optional().describe("Visual style, e.g. 'noir', 'documentary', 'neon cyberpunk'. Also steers lighting."),
        prefer: z.enum(["video", "image"]).optional().describe("Prefer motion b-roll ('video', default) or stills ('image') from stock."),
        stock: z.boolean().optional().describe("Use stock APIs when keys are configured (default true). false = fully offline storyboard/animatic."),
        generative: z.boolean().optional().describe("SPENDS QUOTA/MONEY: generate clips with your Replicate/fal/HF video model (default false)."),
        approveOverBudget: z.boolean().optional().describe("Only after the user agrees: proceed past the free-tier budget guard."),
        render: z.boolean().optional().describe("Render the MP4 now (default true in fully_automated). Uses Remotion if installed, else ffmpeg."),
        narration: z.string().optional().describe("Narration script. Spoken offline by the system TTS (say/flite/espeak-ng), captioned, locked to the timeline; the last shot is held if the narration runs long."),
        captions: z.boolean().optional().describe("Burn narration captions into the video (default true)."),
        soundtrack: z.boolean().optional().describe("Add an offline-synthesized soundtrack fitted to the video length, ducked under narration."),
        musicStyle: z.string().optional().describe("Soundtrack genre: 'lo-fi', 'cinematic orchestral', 'hip-hop', 'trap', 'rock', 'electronic', 'ambient'."),
        enrich: z.boolean().optional().describe("SPENDS MONEY: true + ANTHROPIC_API_KEY polishes the screenplay prose with one Anthropic API call. Default false (offline template prose)."),
      },
    },
    async (args) =>
      guard(async () => {
        const { dry_run, ...input } = args;
        if (dry_run) {
          const plan = await planCinemaPipeline(input);
          return ok(plan, summarizePlan(plan), [], plan.nextSteps);
        }
        const report = await runCinemaPipeline(input);
        return ok(report, summarizeReport(report), reportFiles(report), report.nextSteps);
      }),
  );

  server.registerTool(
    "compile_montage",
    {
      title: "Compile / Re-render a Video Project",
      description:
        "Use after run_cinema_pipeline in interactive_montage mode, or to re-cut any project: rebuilds the timeline from the " +
        "project folder (honoring an optional montage-order.json and any clip files you replaced), validates it (no gaps, " +
        "no missing files) and renders the MP4. Offline; no network. Returns the MP4 path, validation warnings and next steps.",
      inputSchema: {
        projectId: z.string().min(1).describe("The projectId returned by run_cinema_pipeline."),
        render: z.boolean().optional().describe("Render after compiling (default true)."),
      },
    },
    async (args) =>
      guard(async () => {
        const report = await compileMontage(args.projectId, { render: args.render });
        return ok(report, summarizeReport(report), reportFiles(report), report.nextSteps);
      }),
  );

  server.registerTool(
    "install_dependencies",
    {
      title: "Install Local Dependencies (consent required)",
      description:
        "Use when rendering fails because ffmpeg, Blender or the Remotion toolchain is missing. With consent:false (default) it " +
        "only detects the OS and returns the exact commands it WOULD run — nothing is installed. Only call with consent:true " +
        "after the user explicitly agrees; it then runs the package manager (may need sudo) and npm (network).",
      inputSchema: {
        consent: z.boolean().default(false).describe("true runs the install commands. Only set after explicit user approval."),
        targets: z.array(z.enum(["remotion", "ffmpeg", "blender"])).optional().describe("Which dependencies (default all)."),
      },
    },
    async (args) =>
      guard(async () => {
        const report = await installDependencies({ consent: args.consent, targets: args.targets });
        const summary = report.executed
          ? `Installation executed:\n${(report.results ?? []).map((r) => `- ${r.ok ? "ok" : "FAILED"}: ${r.step}`).join("\n") || "- nothing was missing"}`
          : `Nothing installed (consent:false). ${report.consentPrompt}\n\nCommands that WOULD run:\n- ${report.plannedCommands.join("\n- ") || "(nothing missing)"}`;
        const next = report.executed
          ? ["Re-run the failed render (compile_montage) to use the new tools."]
          : report.plannedCommands.length ? ["Show these commands to the user; only if they agree, call install_dependencies with consent:true."] : ["Everything requested is already installed."];
        return ok(report, summary, report.executed ? [report.cacheMapping.npmrc] : [], next);
      }),
  );

  server.registerTool(
    "list_providers",
    {
      title: "List Providers & What Is Configured",
      description:
        "Use to answer 'what can this server do with my keys?'. Lists every catalogued provider (stock, generative video/image, " +
        "audio) with whether its key/model env vars are set. Offline; reads tools-registry.json and env only.",
      inputSchema: {},
    },
    async () =>
      guard(async () => {
        const providers = describeProviders();
        const stock = configuredStockProviders();
        const configured = providers.filter((p) => p.configured).map((p) => p.slug);
        const missing = providers.filter((p) => !p.configured && p.enabled && p.implemented).map((p) => `${p.slug} (${p.authEnv.join(" + ")})`);
        return ok(
          { stockConfigured: stock, providers },
          `Providers: ${providers.length} catalogued · configured: ${configured.join(", ") || "none"}.\nOffline engines always available: SVG designer, storyboard animatic, system TTS, music/SFX synthesis.`,
          [paths.toolsRegistry],
          [missing.length ? `To enable more, set env vars in .env: ${missing.slice(0, 6).join("; ")}${missing.length > 6 ? "; …" : ""}.` : "All implemented providers are configured.", "check_limits shows remaining free-tier quota."],
        );
      }),
  );

  server.registerTool(
    "discover_providers",
    {
      title: "Discover New Providers (review-only)",
      description:
        "Use when the user asks to find new video/model tools. Searches the public Hugging Face Hub and GitHub Search APIs " +
        "(network, no key needed; GITHUB_TOKEN optional) and QUEUES candidates in data/review-queue.json. Never installs, " +
        "enables or runs anything. Returns the top candidates and the queue size.",
      inputSchema: {
        query: z.string().min(1).describe("Search term, e.g. 'text to video'."),
      },
    },
    async (args) =>
      guard(async () => {
        const result = await discover(args.query);
        const top = result.suggestions.slice(0, 5).map((s) => `  • [${s.source}] ${s.id} (★${s.signal}) — ${s.url}`);
        const alert =
          `REVIEW QUEUE — ${result.added} new suggestion(s) (${result.total} awaiting review). Nothing was activated.` +
          (top.length ? `\nTop candidates:\n${top.join("\n")}` : "\nNo candidates found (or the catalogs were unreachable).");
        return ok(result, alert, [paths.reviewQueue], ["Let the user review the candidates. To catalogue one (added DISABLED, unimplemented), call approve_suggestion with its id and approve:true."]);
      }),
  );

  server.registerTool(
    "approve_suggestion",
    {
      title: "Catalogue a Reviewed Suggestion",
      description:
        "Use only after the user approves a discovered candidate. Adds it to tools-registry.json as DISABLED and unimplemented " +
        "(a human must write an adapter and enable it). No network. Requires approve:true; otherwise does nothing.",
      inputSchema: {
        suggestionId: z.string().min(1).describe("The suggestion id from discover_providers."),
        approve: z.boolean().default(false).describe("Must be true to make any change."),
      },
    },
    async (args) =>
      guard(async () => {
        const result = approveSuggestion(args.suggestionId, args.approve);
        const pending = listSuggestions().filter((s) => s.status === "needs_review").length;
        return ok({ ...result, pending }, result.message, result.ok ? [paths.toolsRegistry] : [], [result.ok ? "An adapter in src/providers/ plus enabled:true is still required before it is used." : `${pending} suggestion(s) still await review.`]);
      }),
  );

  server.registerTool(
    "consult_personas",
    {
      title: "Preview the Creative Brief (no generation)",
      description:
        "Use before generating to show/tune the strategy. Runs the persona consultation (Director of Photography, Graphic " +
        "Designer, Voice Director, Music Producer) for an asset kind and returns the compiled brief: positive/negative prompt, " +
        "technical params (palette, lens, BPM/key/structure, pacing) and the debate transcript. Instant, offline, writes nothing.",
      inputSchema: {
        assetKind: z.enum(ASSET_KINDS).describe("What to design."),
        subject: z.string().min(1).describe("The subject/description."),
        style: z.string().optional().describe("Style hint, e.g. 'noir', 'lo-fi', 'brutalist'."),
        aspectRatio: z.string().optional().describe("e.g. '16:9', '1:1', '9:16'."),
      },
    },
    async (args) =>
      guard(async () => {
        const brief = consult(args);
        const gen = args.assetKind === "voiceover" ? "generate_voiceover" : args.assetKind === "soundtrack" ? "generate_soundtrack" : args.assetKind === "sfx" ? "generate_sfx" : "generate_image";
        return ok(brief, `${brief.leadPersona} leads (advisors: ${brief.advisors.join(", ") || "none"}).\n\nStrategy:\n- ${transcriptLines(brief).join("\n- ")}\n\nPrompt: ${brief.positivePrompt}\nAvoid: ${brief.negativePrompt}`, [], [`Call ${gen} with the same subject/style to produce it (offline by default).`]);
      }),
  );

  server.registerTool(
    "generate_image",
    {
      title: "Design an Image (logo, vector art, UI mockup, photo)",
      description:
        "Use for logos, illustrations, app/web mockups, photos and textures.\n" +
        "- logo / vector-art / ui-mockup: designed OFFLINE as clean SVG (plus a PNG export when rsvg-convert or ffmpeg is " +
        "installed). Logos come with -reversed (dark backgrounds) and -icon variants. Free, instant, no network.\n" +
        "- cinematic-photo / texture: need an image API. Without generative:true you get a clearly LABELLED placeholder, not a " +
        "photo. generative:true calls Replicate/Hugging Face with your key (uses quota; budget-guarded → returns a halt with a " +
        "cost breakdown; retry with approveOverBudget:true only if the user agrees).\n" +
        "Style words steer the result: palette ('vibrant', 'warm', 'earth', 'mono'), logo layout ('monogram', 'wordmark', " +
        "'horizontal', 'emblem'), type voice ('luxury', 'tech', 'playful'), 'sharp' corners. Returns file paths, size, license.",
      inputSchema: {
        assetKind: z.enum(["cinematic-photo", "logo", "vector-art", "texture", "ui-mockup"]).describe("Type of visual asset."),
        subject: z.string().min(1).describe("What to create, e.g. 'Nova Labs' (logo), 'fitness mobile app' (ui-mockup), 'mountain sunset'."),
        style: z.string().optional().describe("Style keywords (see description)."),
        aspectRatio: z.string().optional().describe("e.g. '1:1', '16:9', '3:1' (wide logo lockup)."),
        generative: z.boolean().optional().describe("USES QUOTA: photo/texture via your image API key. Ignored for vector kinds."),
        approveOverBudget: z.boolean().optional().describe("Only after the user agrees: proceed past the budget guard."),
      },
    },
    async (args) => guard(async () => engineResult(await generateImageAsset(args))),
  );

  server.registerTool(
    "generate_voiceover",
    {
      title: "Generate Voiceover / Narration",
      description:
        "Use to turn a script into spoken audio (WAV). Offline by default via the system TTS engine (macOS 'say', pico2wave, " +
        "ffmpeg's flite, or espeak-ng): intelligible but synthetic-sounding, loudness-normalized to -16 LUFS. If no engine " +
        "exists you get a timing placeholder TONE that is explicitly labelled NOT SPEECH. generative:true uses your Hugging " +
        "Face TTS model (HF_TTS_MODEL; quota, budget-guarded) for a natural voice. Returns the WAV path and exact duration in ms.",
      inputSchema: {
        subject: z.string().min(1).describe("The narration text (or a topic if you also pass script)."),
        script: z.string().optional().describe("Explicit script (overrides subject as the spoken text)."),
        style: z.string().optional().describe("Delivery: 'dramatic' (slower, deeper), 'calm documentary', 'energetic'."),
        generative: z.boolean().optional().describe("USES QUOTA: natural voice via HF_TTS_MODEL."),
        approveOverBudget: z.boolean().optional().describe("Only after the user agrees: proceed past the budget guard."),
      },
    },
    async (args) => guard(async () => engineResult(await generateVoiceover({ ...args, assetKind: "voiceover" }), ["Pass the same text as `narration` to run_cinema_pipeline to lock it to a video with captions."])),
  );

  server.registerTool(
    "generate_soundtrack",
    {
      title: "Compose a Soundtrack / Beat",
      description:
        "Use for background music or a beat in a genre: hip-hop, trap/rap, cinematic orchestral, rock, lo-fi, electronic, " +
        "ambient. Offline by default: the Music Producer plans tempo/key/structure/instruments and the engine composes and " +
        "synthesizes a stereo WAV (voice-led chords, bass, drums, a melody, section dynamics, mastered to about -14 LUFS) plus " +
        "an editable multi-track MIDI. It is a synthesized demo, not a studio recording. generative:true uses your MusicGen " +
        "model on Replicate/HF (quota, budget-guarded). Returns WAV + MIDI paths, exact duration, and the arrangement.",
      inputSchema: {
        subject: z.string().min(1).describe("Theme/mood, e.g. 'rainy midnight city'."),
        style: z.string().optional().describe("Genre, e.g. 'hip-hop', 'cinematic orchestral', 'lo-fi', 'electronic'."),
        durationSeconds: z.number().min(5).max(600).optional().describe("Target length; the arrangement is re-flowed to fit (whole bars)."),
        generative: z.boolean().optional().describe("USES QUOTA: render via your MusicGen API model."),
        approveOverBudget: z.boolean().optional().describe("Only after the user agrees: proceed past the budget guard."),
      },
    },
    async (args) => guard(async () => {
      const { durationSeconds, ...rest } = args;
      return engineResult(await generateSoundtrack({ ...rest, assetKind: "soundtrack", targetDurationMs: durationSeconds ? durationSeconds * 1000 : undefined }), ["Open the .mid in a DAW to re-voice it, or use soundtrack:true + musicStyle in run_cinema_pipeline to score a video."]);
    }),
  );

  server.registerTool(
    "generate_sfx",
    {
      title: "Create a Sound Effect",
      description:
        "Use for a sound effect or ambience. Offline by default: procedural synthesis matched to the request (whoosh, rain, " +
        "thunder, wind, ocean, impact, riser, click, ding, beep, fire, footsteps, heartbeat). generative:true searches " +
        "Freesound with your FREESOUND_API_KEY (network, CC-licensed results, budget-guarded). Returns the file path, exact " +
        "duration and license.",
      inputSchema: {
        subject: z.string().min(1).describe("The effect, e.g. 'whoosh transition', 'rain ambience'."),
        style: z.string().optional(),
        generative: z.boolean().optional().describe("NETWORK: fetch a real recording from Freesound."),
        approveOverBudget: z.boolean().optional().describe("Only after the user agrees: proceed past the budget guard."),
      },
    },
    async (args) => guard(async () => engineResult(await generateSfx({ ...args, assetKind: "sfx" }))),
  );

  server.registerTool(
    "check_limits",
    {
      title: "Check Free-Tier Usage",
      description:
        "Use before a generative run or when the user asks about remaining quota. Reports per-provider usage vs the budget " +
        "guard's daily/weekly/monthly limits from data/usage-limits.json. Offline.",
      inputSchema: {
        provider: z.string().optional().describe("A single provider slug; omit for all tracked providers."),
      },
    },
    async (args) =>
      guard(async () => {
        const providers = args.provider ? [args.provider] : TRACKED_LIMIT_PROVIDERS;
        const statuses = providers.map((p) => getStatus(p));
        const lines = statuses.map((s) => `${s.provider.padEnd(18)} today ${s.periods.daily.used}/${s.periods.daily.limit} · week ${s.periods.weekly.used}/${s.periods.weekly.limit} · month ${s.periods.monthly.used}/${s.periods.monthly.limit}`);
        return ok({ providers: statuses }, `Usage (guard rails halt generative calls near a limit unless approved):\n${lines.join("\n")}`, fs.existsSync(paths.usageLimits) ? [paths.usageLimits] : [], ["Override a limit with env LIMIT_<PROVIDER>_<DAILY|WEEKLY|MONTHLY>=<n>."]);
      }),
  );

  server.registerTool(
    "ipc_start",
    {
      title: "Start Local REST API",
      description:
        "Use when another local program needs to request assets from this engine over HTTP. Starts a server bound to " +
        "127.0.0.1 with a bearer token (stored in data/ipc-token.txt, mode 0600). Returns the URL and token. Stop it with ipc_stop.",
      inputSchema: {
        port: z.number().int().min(0).max(65535).optional().describe("Port (default OMNICINEMA_IPC_PORT or 8787; 0 = any free port)."),
      },
    },
    async (args) =>
      guard(async () => {
        const info = await ipcServer.start(args.port);
        return ok(info, `IPC server on ${info.url}\nBearer token: ${info.token}`, [paths.ipcToken], [`GET ${info.url}/schema with 'Authorization: Bearer <token>' for the contract.`, "Call ipc_stop when done."]);
      }),
  );

  server.registerTool(
    "ipc_status",
    {
      title: "Local REST API Status",
      description: "Use to check whether the local REST API is running and where. Offline.",
      inputSchema: {},
    },
    async () => guard(async () => ok({ running: ipcServer.running, ...(ipcServer.running ? ipcServer.info : {}) }, ipcServer.running ? `Running on ${ipcServer.info.url}` : "IPC server is not running.", [], [ipcServer.running ? "Call ipc_stop to shut it down." : "Call ipc_start to start it."])),
  );

  server.registerTool(
    "ipc_stop",
    {
      title: "Stop Local REST API",
      description: "Use to shut down the local REST API started by ipc_start.",
      inputSchema: {},
    },
    async () => guard(async () => { await ipcServer.stop(); return ok({ running: false }, "IPC server stopped.", [], ["Nothing else to do."]); }),
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`omnicinema-mcp ${VERSION} started on stdio.`);
}

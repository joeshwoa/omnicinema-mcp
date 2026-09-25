/**
 * Pipeline orchestrator — the body behind the `run_cinema_pipeline` MCP tool.
 *
 * Sequences: screenplay + continuity -> (optional, budget-gated) generative
 * clips -> stock / offline storyboard assets -> frame-accurate timeline (+
 * narration, captions, soundtrack fitted to the cut) -> validation -> render
 * (Remotion, or ffmpeg assembly). In `interactive_montage` mode it pauses after
 * asset acquisition so the user can arrange clips; `compileMontage` finishes.
 *
 * `planCinemaPipeline` is the cheap dry run: screenplay, shot list, provider
 * choice and a cost/quota estimate — no downloads, no generation, no files.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, paths, projectDir as resolveProjectDir } from "../config.js";
import { log } from "../logger.js";
import { acquireAssets, configuredStockProviders, orderedStockProviders } from "../assets/stockManager.js";
import { GENERATIVE_PROVIDERS, anyGenerativeConfigured, generateForShot } from "../providers/registry.js";
import { checkBudget, consume, breakdownLines } from "../limits/limit-manager.js";
import {
  attachAudio, auditAudioSync, buildCaptions, buildTimeline, extendToCover, framesFromMs,
  validateTimeline, writeTimeline, type AudioAttachment,
} from "../montage/timeline.js";
import { isRemotionAvailable, renderCapability, renderTimeline } from "../montage/render.js";
import { generateSoundtrack, generateVoiceover } from "./audio-engine.js";
import { isHalt } from "./asset-results.js";
import type { AssetClip, PipelineReport, Screenplay, Shot, Timeline, WorkflowMode } from "../types.js";
import { buildScreenplay, enrichScreenplay, verifyContinuity } from "./script-engine.js";
import { env } from "../config.js";

export interface CinemaPipelineInput {
  prompt: string;
  workflow_mode: WorkflowMode;
  sceneCount?: number;
  shotsPerScene?: number;
  shotDurationSeconds?: number;
  fps?: number;
  width?: number;
  height?: number;
  style?: string;
  prefer?: "video" | "image";
  generative?: boolean;
  render?: boolean;
  enrich?: boolean;
  /** Optional narration script; spoken offline (system TTS) and captioned. */
  narration?: string;
  /** Add an offline-synthesized soundtrack bed fitted to the cut. */
  soundtrack?: boolean;
  /** Genre/style for the soundtrack (e.g. "lo-fi", "cinematic orchestral"). */
  musicStyle?: string;
  /** Use stock APIs when keys are configured (default true). false = offline storyboard only. */
  stock?: boolean;
  /** Burn narration captions into the video (default true when narration is given). */
  captions?: boolean;
  /** Proceed even if the free-tier budget guard flags generative/stock usage. */
  approveOverBudget?: boolean;
}

function normalize(input: CinemaPipelineInput) {
  return {
    fps: clampInt(input.fps ?? 30, 1, 120),
    width: clampInt(input.width ?? 1920, 16, 7680),
    height: clampInt(input.height ?? 1080, 16, 4320),
    prefer: input.prefer ?? "video",
  } as const;
}

// ── Dry run ──────────────────────────────────────────────────────────────────

export interface PipelinePlan {
  dryRun: true;
  title: string;
  logline: string;
  style: string;
  format: string;
  totalSeconds: number;
  scenes: { heading: string; beat?: string; summary: string; shots: { id: string; type?: string; seconds: number; camera: string; action: string; query: string }[] }[];
  assets: {
    stockProviders: string[];
    generative: { requested: boolean; configured: string[]; unitsPerProvider: number; budget: { provider: string; allowed: boolean; message: string; breakdown: string[] }[] };
    fallback: string;
  };
  audio: { narration: string | null; estimatedNarrationSeconds: number | null; soundtrack: string | null; tts: string };
  render: { engine: "remotion" | "ffmpeg" | null; willRender: boolean };
  network: string[];
  spend: string[];
  llmEnrichment: boolean;
  nextSteps: string[];
}

/** Cheap preview: no files, no downloads, no generation, no quota consumed. */
export async function planCinemaPipeline(input: CinemaPipelineInput): Promise<PipelinePlan> {
  const { fps, width, height } = normalize(input);
  const sp = buildScreenplay({ prompt: input.prompt, sceneCount: input.sceneCount, shotsPerScene: input.shotsPerScene, shotDurationSeconds: input.shotDurationSeconds, style: input.style, fps, width, height });
  const shots = sp.scenes.flatMap((s) => s.shots);
  const stockProviders = input.stock === false ? [] : configuredStockProviders(orderedStockProviders());
  const genConfigured = GENERATIVE_PROVIDERS.filter((p) => p.configured()).map((p) => p.slug);
  const budget = input.generative ? genConfigured.map((slug) => {
    const d = checkBudget(slug, shots.length);
    return { provider: slug, allowed: d.allowed, message: d.message, breakdown: breakdownLines(d) };
  }) : [];
  const engine = await renderCapability();
  const wantRender = input.workflow_mode !== "interactive_montage" && (input.render ?? true);
  const { detectTts } = await import("../audio/tts.js");
  const tts = await detectTts();
  const words = input.narration?.split(/\s+/).filter(Boolean).length ?? 0;
  const network: string[] = [];
  const spend: string[] = [];
  if (stockProviders.length) network.push(`Stock search + downloads via ${stockProviders.join(", ")} (free APIs; ~${shots.length}-${shots.length * 3} requests, counted by the budget guard).`);
  if (input.generative && genConfigured.length) {
    network.push(`Generative video via ${genConfigured.join(" → ")} (${shots.length} clip requests).`);
    spend.push(`Generative video: up to ${shots.length} generations on ${genConfigured[0]} (falls through to the next provider on failure). This spends your free quota or PAID credits at that provider's rates.`);
  }
  if (input.enrich !== false && env.anthropic()) {
    network.push("Screenplay enrichment via the Anthropic API (1 request).");
    spend.push("Screenplay enrichment: 1 Anthropic API call (billed to ANTHROPIC_API_KEY).");
  }
  const nextSteps = [
    `Review the shot list above. To produce it, call run_cinema_pipeline again with the same arguments and dry_run:false${wantRender ? "" : " (render:true to get an MP4)"}.`,
  ];
  if (!stockProviders.length && input.stock !== false) nextSteps.push("No stock key set: every shot will be an offline storyboard frame (an animatic). Set PEXELS_API_KEY / PIXABAY_API_KEY / UNSPLASH_ACCESS_KEY for real footage.");
  if (input.generative && budget.some((b) => !b.allowed)) nextSteps.push("The budget guard would halt generative video; add approveOverBudget:true only if you accept the spend.");
  if (wantRender && !engine) nextSteps.push("No render engine found: install ffmpeg or run `npm run setup:render` (install_dependencies can do this with consent).");
  return {
    dryRun: true,
    title: sp.title,
    logline: sp.logline,
    style: sp.style,
    format: `${width}×${height} @ ${fps}fps`,
    totalSeconds: shots.reduce((n, s) => n + s.durationSeconds, 0),
    scenes: sp.scenes.map((sc) => ({
      heading: sc.heading, beat: sc.beat, summary: sc.summary,
      shots: sc.shots.map((s) => ({ id: s.id, type: s.shotType, seconds: s.durationSeconds, camera: s.cameraMovement, action: s.action, query: s.assetQuery })),
    })),
    assets: {
      stockProviders,
      generative: { requested: Boolean(input.generative), configured: genConfigured, unitsPerProvider: shots.length, budget },
      fallback: "offline storyboard frames (SVG → PNG) with Ken Burns motion",
    },
    audio: {
      narration: input.narration ?? null,
      estimatedNarrationSeconds: words ? Math.round((words / 150) * 60 + 1) : null,
      soundtrack: input.soundtrack ? input.musicStyle || input.style || "cinematic" : null,
      tts: tts ? `${tts.engine} (offline system TTS)` : "none found — voiceover would be a labelled tone placeholder",
    },
    render: { engine, willRender: wantRender && Boolean(engine) },
    network: network.length ? network : ["None — this run is fully offline."],
    spend: spend.length ? spend : ["Nothing — no paid API is used."],
    llmEnrichment: input.enrich !== false && Boolean(env.anthropic()),
    nextSteps,
  };
}

// ── Full run ────────────────────────────────────────────────────────────────

export async function runCinemaPipeline(input: CinemaPipelineInput): Promise<PipelineReport> {
  ensureDirs();
  const { fps, width, height, prefer } = normalize(input);

  // 1. Screenplay + continuity.
  let screenplay = buildScreenplay({
    prompt: input.prompt,
    sceneCount: input.sceneCount,
    shotsPerScene: input.shotsPerScene,
    shotDurationSeconds: input.shotDurationSeconds,
    style: input.style,
    fps,
    width,
    height,
  });
  if (input.enrich !== false) {
    screenplay = await enrichScreenplay(screenplay);
  }
  const continuityBreaks = verifyContinuity(screenplay);

  const projectId = makeProjectId(screenplay.title);
  const projectAbsDir = resolveProjectDir(projectId);
  fs.mkdirSync(projectAbsDir, { recursive: true });
  const screenplayPath = writeScreenplayFiles(projectAbsDir, screenplay);

  const warnings: string[] = [];
  const nextSteps: string[] = [];
  for (const b of continuityBreaks) warnings.push(`continuity: ${b}`);

  // 2. Assets: generative (opt-in, budget-gated) first, then stock/placeholder.
  const shots: Shot[] = screenplay.scenes.flatMap((s) => s.shots);
  const clipByShot = new Map<string, AssetClip>();

  if (input.generative && anyGenerativeConfigured()) {
    const gated = GENERATIVE_PROVIDERS.filter((p) => p.configured());
    const decision = checkBudget(gated[0]!.slug, shots.length);
    if (decision.requiresApproval && !input.approveOverBudget) {
      warnings.push(`generative: budget guard halted ${shots.length} generation(s) on ${gated[0]!.slug} — ${decision.message}`);
      nextSteps.push(`Generative video was NOT used (budget guard): ${breakdownLines(decision).join("; ")}. Re-run with approveOverBudget:true to spend it.`);
    } else {
      log.info("Generative video enabled; attempting per-shot generation.");
      for (const shot of shots) {
        const dest = path.join(projectAbsDir, `${shot.id}.mp4`);
        const genPrompt = buildGenPrompt(screenplay, shot);
        const res = await generateForShot(genPrompt, dest, { width, height, durationSeconds: shot.durationSeconds, fps });
        if (res.ok) {
          consume(res.provider, 1, true);
          clipByShot.set(shot.id, {
            id: `clip-${shot.id}`, shotId: shot.id, source: "generative",
            provider: res.provider, remoteUrl: "", localPath: `${shot.id}.mp4`,
            durationSeconds: shot.durationSeconds, kind: "video", width, height,
            license: res.license, attribution: res.attribution,
          });
        } else if (res.note && res.note !== "not configured") {
          warnings.push(`generative(${res.provider}) ${shot.id}: ${res.note}`);
        }
      }
    }
  } else if (input.generative) {
    warnings.push("Generative requested but no generative provider is configured (REPLICATE_API_TOKEN+REPLICATE_VIDEO_MODEL, FAL_API_KEY+FAL_VIDEO_MODEL or HUGGINGFACE_API_TOKEN+HF_VIDEO_MODEL); using stock/storyboard.");
  }

  const stock = await acquireAssets(screenplay, {
    projectAbsDir,
    prefer,
    skipShotIds: new Set(clipByShot.keys()),
    offline: input.stock === false,
    approveOverBudget: input.approveOverBudget,
  });
  for (const c of stock.clips) clipByShot.set(c.shotId, c);
  warnings.push(...stock.warnings);

  const clips: AssetClip[] = shots.map((s) => clipByShot.get(s.id)!).filter(Boolean);
  writeAttributions(projectAbsDir, screenplay, clips);

  // 3. Timeline + optional audio + validation.
  let timeline = buildTimeline(screenplay, clips);
  const audioSummary: { role: string; src: string; durationMs: number }[] = [];
  if (input.narration || input.soundtrack) {
    const attachments: AudioAttachment[] = [];
    const voStart = Math.round(fps * 0.6);
    if (input.narration) {
      const vo = await generateVoiceover({
        assetKind: "voiceover", subject: input.narration, style: input.style,
        outDir: projectAbsDir, generative: false,
      });
      if (!isHalt(vo)) {
        const voMs = vo.durationMs ?? 0;
        attachments.push({ src: vo.relPath, role: "voiceover", durationMs: voMs, startFrame: voStart });
        audioSummary.push({ role: "voiceover", src: vo.relPath, durationMs: voMs });
        for (const w of vo.warnings) warnings.push(`voiceover: ${w}`);
        // Never cut narration off: hold the final shot until it finishes.
        const ext = extendToCover(timeline, voStart + framesFromMs(voMs, fps), Math.round(fps * 1.2));
        if (ext.addedFrames > 0) {
          timeline = ext.timeline;
          warnings.push(`Narration (${(voMs / 1000).toFixed(1)}s) was longer than the cut; held the final shot ${(ext.addedFrames / fps).toFixed(1)}s longer. Use more shots or a longer shotDurationSeconds to avoid this.`);
        }
        // Captions follow the spoken timing (and carry the words if TTS was unavailable).
        if (input.captions !== false) timeline.captions = buildCaptions(input.narration, voStart, framesFromMs(voMs, fps));
      }
    }
    if (input.soundtrack) {
      const targetMs = Math.round((timeline.durationInFrames / fps) * 1000);
      const st = await generateSoundtrack({
        assetKind: "soundtrack", subject: input.prompt,
        style: input.musicStyle || input.style || "cinematic",
        outDir: projectAbsDir, generative: false, targetDurationMs: targetMs,
      });
      if (!isHalt(st)) {
        attachments.push({ src: st.relPath, role: "soundtrack", durationMs: st.durationMs ?? 0, volume: input.narration ? 0.6 : 0.8 });
        audioSummary.push({ role: "soundtrack", src: st.relPath, durationMs: st.durationMs ?? 0 });
      }
    }
    timeline = attachAudio(timeline, attachments);
    for (const issue of auditAudioSync(timeline)) warnings.push(`audio:${issue.level}: ${issue.message}`);
  }

  const timelinePath = writeTimeline(projectAbsDir, timeline);
  const issues = validateTimeline(timeline, projectAbsDir);
  for (const issue of issues) {
    warnings.push(`timeline:${issue.level}:${issue.itemId ?? "-"}: ${issue.message}`);
  }
  const hasErrors = issues.some((i) => i.level === "error");

  // 4. Mode handling.
  const paused = input.workflow_mode === "interactive_montage";
  let renderedVideoPath: string | null = null;
  let renderEngine: string | null = null;

  if (paused) {
    nextSteps.push(
      `Interactive mode: review the clips in ${projectAbsDir} (replace any file, keeping its name, to swap a shot).`,
      `Optionally write ${path.join(projectAbsDir, "montage-order.json")} — a JSON array of clip filenames in the order you want.`,
      `Then call compile_montage with projectId="${projectId}" to build the final video.`,
    );
  } else {
    const wantRender = input.render ?? true;
    if (wantRender && !hasErrors) {
      const r = await renderTimeline(projectId, projectAbsDir, timelinePath, timeline);
      renderedVideoPath = r.outputPath;
      renderEngine = r.engine ?? null;
      if (!r.rendered) {
        warnings.push(`render: ${r.reason ?? "failed"}${r.log ? ` :: ${r.log}` : ""}`);
        nextSteps.push("Rendering failed or no engine is available: install ffmpeg or run `npm run setup:render`, then call compile_montage.");
      } else if (r.reason) warnings.push(`render: ${r.reason}`);
    } else if (wantRender && hasErrors) {
      nextSteps.push("Timeline has validation errors; fix the listed assets, then call compile_montage.");
    } else {
      nextSteps.push(`Not rendered (render:false). Call compile_montage with projectId="${projectId}" to render.`);
    }
  }
  if (renderedVideoPath) nextSteps.push(`Watch ${renderedVideoPath}. To re-cut, edit montage-order.json or swap clip files in ${projectAbsDir} and call compile_montage.`);
  if (clips.some((c) => c.source === "placeholder")) {
    nextSteps.push("Storyboard frames stand in for footage. For real b-roll set PEXELS_API_KEY (or PIXABAY_API_KEY / UNSPLASH_ACCESS_KEY) and re-run; check list_providers.");
  }

  const report = assembleReport({
    projectId, projectAbsDir, screenplay, timeline, screenplayPath, timelinePath,
    clips, renderedVideoPath, warnings, nextSteps, paused, mode: input.workflow_mode,
  });
  if (audioSummary.length) report.audio = audioSummary;
  if (renderEngine) report.renderEngine = renderEngine;
  report.durationSeconds = Math.round((timeline.durationInFrames / fps) * 100) / 100;
  writeManifest(projectAbsDir, report);
  return report;
}

/** Resume an interactive project: (re)build + validate + render the montage. */
export async function compileMontage(
  projectId: string,
  opts: { render?: boolean } = {},
): Promise<PipelineReport> {
  if (!/^[\w.-]+$/.test(projectId)) throw new Error(`Invalid projectId "${projectId}".`);
  const projectAbsDir = resolveProjectDir(projectId);
  const timelineFile = path.join(projectAbsDir, "timeline.json");
  const screenplayFile = path.join(projectAbsDir, "screenplay.json");
  if (!fs.existsSync(timelineFile)) {
    throw new Error(`No timeline.json found for project "${projectId}" at ${projectAbsDir}. Run run_cinema_pipeline first (list projects under ${paths.projects}).`);
  }
  const timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8")) as Timeline;
  const screenplay = fs.existsSync(screenplayFile)
    ? (JSON.parse(fs.readFileSync(screenplayFile, "utf8")) as Screenplay)
    : null;

  // Optional user-provided ordering.
  const ordered = applyMontageOrder(projectAbsDir, timeline);
  writeTimeline(projectAbsDir, ordered);

  const warnings: string[] = [];
  const issues = validateTimeline(ordered, projectAbsDir);
  for (const issue of issues) warnings.push(`timeline:${issue.level}:${issue.itemId ?? "-"}: ${issue.message}`);
  const hasErrors = issues.some((i) => i.level === "error");

  let renderedVideoPath: string | null = null;
  let renderEngine: string | undefined;
  const nextSteps: string[] = [];
  const wantRender = opts.render ?? true;
  if (wantRender && !hasErrors) {
    const r = await renderTimeline(projectId, projectAbsDir, path.join(projectAbsDir, "timeline.json"), ordered);
    renderedVideoPath = r.outputPath;
    renderEngine = r.engine;
    if (!r.rendered) {
      warnings.push(`render: ${r.reason ?? "failed"}${r.log ? ` :: ${r.log}` : ""}`);
      nextSteps.push(isRemotionAvailable() ? "Render failed; see the warning log." : "No render engine: install ffmpeg or run `npm run setup:render`.");
    } else nextSteps.push(`Watch ${renderedVideoPath}.`);
  } else if (hasErrors) {
    nextSteps.push("Timeline has validation errors; resolve them (missing files are listed) before rendering.");
  } else {
    nextSteps.push(`Timeline rebuilt. Call compile_montage with projectId="${projectId}" and render:true to render.`);
  }

  const report = assembleReport({
    projectId, projectAbsDir,
    screenplay: screenplay ?? syntheticScreenplay(ordered),
    timeline: ordered,
    screenplayPath: fs.existsSync(screenplayFile) ? screenplayFile : "",
    timelinePath: path.join(projectAbsDir, "timeline.json"),
    clips: [], renderedVideoPath, warnings, nextSteps, paused: false, mode: "interactive_montage",
  });
  report.assets = summarizeFromTimeline(ordered);
  if (renderEngine) report.renderEngine = renderEngine;
  report.durationSeconds = Math.round((ordered.durationInFrames / ordered.fps) * 100) / 100;
  writeManifest(projectAbsDir, report);
  return report;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function applyMontageOrder(projectDir: string, timeline: Timeline): Timeline {
  const orderFile = path.join(projectDir, "montage-order.json");
  if (!fs.existsSync(orderFile)) return retile(timeline, timeline.items);
  try {
    const order = JSON.parse(fs.readFileSync(orderFile, "utf8")) as string[];
    if (!Array.isArray(order)) throw new Error("montage-order.json must be a JSON array of filenames");
    const bySrc = new Map(timeline.items.map((i) => [i.src, i]));
    const reordered = order.map((src) => bySrc.get(src)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    const leftovers = timeline.items.filter((i) => !order.includes(i.src));
    return retile(timeline, [...reordered, ...leftovers]);
  } catch (err) {
    log.warn(`Could not apply montage-order.json: ${String(err)}`);
    return retile(timeline, timeline.items);
  }
}

/**
 * Recompute startFrames so items tile with no gaps/overlaps after reordering,
 * and re-derive transitions from the NEW neighbours: dissolve where the scene
 * changes, hard cut inside a scene.
 */
export function retile(base: Timeline, items: Timeline["items"]): Timeline {
  let cursor = 0;
  const dissolve = Math.max(1, Math.round(base.fps * 0.6));
  const next = items.map((it, idx) => {
    const startFrame = cursor;
    cursor += it.durationInFrames;
    const prev = idx > 0 ? items[idx - 1] : undefined;
    const sceneChange = prev !== undefined && (it.sceneIndex === undefined || prev.sceneIndex === undefined ? it.transitionInFrames > 0 : it.sceneIndex !== prev.sceneIndex);
    const transitionInFrames = sceneChange ? Math.min(dissolve, Math.floor(it.durationInFrames / 2)) : 0;
    return { ...it, id: `item-${idx + 1}`, startFrame, transitionInFrames };
  });
  const durationInFrames = Math.max(1, cursor);
  // Keep soundtrack/captions inside the (possibly changed) picture length.
  const audioTracks = base.audioTracks?.map((t) => (t.role === "soundtrack" ? { ...t, durationInFrames: Math.max(1, Math.min(t.durationInFrames, durationInFrames - t.startFrame)) } : t));
  return { ...base, items: next, durationInFrames, ...(audioTracks ? { audioTracks } : {}) };
}

function buildGenPrompt(screenplay: Screenplay, shot: Shot): string {
  const f = shot.closingFrame;
  return `${screenplay.style}. ${shot.action} Camera: ${shot.cameraMovement}, ${f.framing}. Lighting: ${f.lighting}. Palette: ${f.palette.join(", ")}.`;
}

function makeProjectId(title: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
  return `${stamp}_${slug(title) || "film"}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function writeScreenplayFiles(dir: string, sp: Screenplay): string {
  fs.writeFileSync(path.join(dir, "screenplay.json"), JSON.stringify(sp, null, 2), "utf8");
  const md = renderScreenplayMarkdown(sp);
  const mdPath = path.join(dir, "screenplay.md");
  fs.writeFileSync(mdPath, md, "utf8");
  return mdPath;
}

function renderScreenplayMarkdown(sp: Screenplay): string {
  const lines: string[] = [];
  lines.push(`# ${sp.title}`, "", `*${sp.logline}*`, "", `**Style:** ${sp.style}  `, `**Format:** ${sp.width}×${sp.height} @ ${sp.fps}fps  `, `**Enriched by LLM:** ${sp.enriched ? "yes" : "no"}`, "");
  for (const scene of sp.scenes) {
    lines.push(`## ${scene.index + 1}. ${scene.heading}`, "", `${scene.beat ? `**Beat:** ${scene.beat}. ` : ""}${scene.summary}`, "");
    for (const shot of scene.shots) {
      lines.push(
        `### ${shot.id}${shot.shotType ? ` — ${shot.shotType}` : ""}`,
        `- **Action:** ${shot.action}`,
        `- **Camera:** ${shot.cameraMovement} · ${shot.durationSeconds}s`,
        `- **Opening frame:** ${frameLine(shot.openingFrame)}`,
        `- **Closing frame:** ${frameLine(shot.closingFrame)}  _(next shot opens here → continuity)_`,
        `- **Asset query:** \`${shot.assetQuery}\``,
        "",
      );
    }
  }
  return lines.join("\n");
}

function frameLine(f: Screenplay["scenes"][number]["shots"][number]["openingFrame"]): string {
  return `${f.framing}; ${f.composition}; ${f.subjectPosition}; light: ${f.lighting}; palette: ${f.palette.join("/")}`;
}

function writeAttributions(dir: string, sp: Screenplay, clips: AssetClip[]): void {
  const lines = [`Attributions & licenses for "${sp.title}"`, "=".repeat(48), ""];
  for (const c of clips) {
    lines.push(`${c.shotId}  [${c.source}/${c.provider}]  ${c.attribution}  — ${c.license}${c.remoteUrl ? `  <${c.remoteUrl}>` : ""}`);
  }
  fs.writeFileSync(path.join(dir, "attributions.txt"), lines.join("\n") + "\n", "utf8");
}

function assembleReport(a: {
  projectId: string; projectAbsDir: string; screenplay: Screenplay; timeline: Timeline;
  screenplayPath: string; timelinePath: string; clips: AssetClip[]; renderedVideoPath: string | null;
  warnings: string[]; nextSteps: string[]; paused: boolean; mode: WorkflowMode;
}): PipelineReport {
  const bySource: Record<string, number> = {};
  for (const c of a.clips) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  return {
    projectId: a.projectId,
    projectPath: a.projectAbsDir,
    mode: a.mode,
    title: a.screenplay.title,
    logline: a.screenplay.logline,
    sceneCount: a.screenplay.scenes.length,
    shotCount: a.screenplay.scenes.reduce((n, s) => n + s.shots.length, 0),
    screenplayPath: a.screenplayPath,
    timelinePath: a.timelinePath,
    remotionProjectPath: paths.remotion,
    renderedVideoPath: a.renderedVideoPath,
    assets: { total: a.clips.length, bySource },
    warnings: a.warnings,
    nextSteps: a.nextSteps,
    paused: a.paused,
  };
}

function summarizeFromTimeline(t: Timeline): PipelineReport["assets"] {
  const bySource: Record<string, number> = {};
  for (const it of t.items) bySource[it.kind] = (bySource[it.kind] ?? 0) + 1;
  return { total: t.items.length, bySource };
}

function syntheticScreenplay(t: Timeline): Screenplay {
  return {
    title: "Recompiled Montage", logline: "Rebuilt from an existing timeline.",
    prompt: "", style: "montage", fps: t.fps, width: t.width, height: t.height,
    scenes: [], enriched: false,
  };
}

function writeManifest(dir: string, report: PipelineReport): void {
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(report, null, 2), "utf8");
}

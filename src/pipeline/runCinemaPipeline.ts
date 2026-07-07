/**
 * Pipeline orchestrator — the body behind the `run_cinema_pipeline` MCP tool.
 *
 * Sequences: screenplay + continuity -> (optional) generative clips -> stock /
 * placeholder assets -> frame-accurate timeline -> validation -> (optional)
 * Remotion render. In `interactive_montage` mode it pauses after asset
 * acquisition so the user can arrange clips, then `compileMontage` finishes.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureDirs, paths, projectDir as resolveProjectDir } from "../config.js";
import { log } from "../logger.js";
import { acquireAssets } from "../assets/stockManager.js";
import { anyGenerativeConfigured, generateForShot } from "../providers/registry.js";
import { attachAudio, auditAudioSync, buildTimeline, validateTimeline, writeTimeline, type AudioAttachment } from "../montage/timeline.js";
import { isRemotionAvailable, renderTimeline } from "../montage/render.js";
import { generateSoundtrack, generateVoiceover } from "./audio-engine.js";
import { isHalt } from "./asset-results.js";
import type { AssetClip, PipelineReport, Screenplay, Shot, Timeline, WorkflowMode } from "../types.js";
import { buildScreenplay, enrichScreenplay, verifyContinuity } from "./script-engine.js";

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
  /** Optional narration script; generated offline and locked to the timeline. */
  narration?: string;
  /** Add an offline-synthesized soundtrack bed. */
  soundtrack?: boolean;
  /** Genre/style for the soundtrack (e.g. "lo-fi", "cinematic orchestral"). */
  musicStyle?: string;
}

export async function runCinemaPipeline(input: CinemaPipelineInput): Promise<PipelineReport> {
  ensureDirs();
  const fps = clampInt(input.fps ?? 30, 1, 120);
  const width = clampInt(input.width ?? 1920, 16, 7680);
  const height = clampInt(input.height ?? 1080, 16, 4320);
  const prefer = input.prefer ?? "video";

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
  for (const b of continuityBreaks) warnings.push(`continuity: ${b}`);

  // 2. Assets: generative (opt-in) first, then stock/placeholder for the rest.
  const shots: Shot[] = screenplay.scenes.flatMap((s) => s.shots);
  const clipByShot = new Map<string, AssetClip>();

  if (input.generative && anyGenerativeConfigured()) {
    log.info("Generative video enabled; attempting per-shot generation.");
    for (const shot of shots) {
      const dest = path.join(projectAbsDir, `${shot.id}.mp4`);
      const genPrompt = buildGenPrompt(screenplay, shot);
      const res = await generateForShot(genPrompt, dest, {
        width, height, durationSeconds: shot.durationSeconds, fps,
      });
      if (res.ok) {
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
  } else if (input.generative) {
    warnings.push("Generative requested but no generative provider is configured; using stock/placeholder.");
  }

  const stock = await acquireAssets(screenplay, {
    projectAbsDir,
    prefer,
    skipShotIds: new Set(clipByShot.keys()),
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
    if (input.narration) {
      const vo = await generateVoiceover({
        assetKind: "voiceover", subject: input.narration, style: input.style,
        outDir: projectAbsDir, generative: false,
      });
      if (!isHalt(vo)) {
        attachments.push({ src: vo.relPath, role: "voiceover", durationMs: vo.durationMs ?? 0 });
        audioSummary.push({ role: "voiceover", src: vo.relPath, durationMs: vo.durationMs ?? 0 });
      }
    }
    if (input.soundtrack) {
      const st = await generateSoundtrack({
        assetKind: "soundtrack", subject: input.prompt,
        style: input.musicStyle || input.style || "cinematic",
        outDir: projectAbsDir, generative: false,
      });
      if (!isHalt(st)) {
        attachments.push({ src: st.relPath, role: "soundtrack", durationMs: st.durationMs ?? 0, volume: input.narration ? 0.28 : 0.5 });
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
  const nextSteps: string[] = [];

  if (paused) {
    nextSteps.push(
      `Interactive mode: review and arrange clips in ${projectAbsDir}.`,
      `Optionally create montage-order.json (an array of clip filenames in the order you want).`,
      `Then run the "compile_montage" tool with projectId="${projectId}" to build the final video.`,
    );
  } else {
    const wantRender = input.render ?? true;
    if (wantRender && !hasErrors && isRemotionAvailable()) {
      const r = await renderTimeline(projectId, projectAbsDir, timelinePath, timeline);
      renderedVideoPath = r.outputPath;
      if (!r.rendered) warnings.push(`render: ${r.reason ?? "failed"}${r.log ? ` :: ${r.log}` : ""}`);
    } else if (wantRender && hasErrors) {
      nextSteps.push("Timeline has validation errors; fix assets before rendering.");
    } else if (wantRender) {
      nextSteps.push("Remotion not installed. Run `npm run setup:render`, then call compile_montage to render.");
    }
  }

  const report = assembleReport({
    projectId, projectAbsDir, screenplay, timeline, screenplayPath, timelinePath,
    clips, renderedVideoPath, warnings, nextSteps, paused, mode: input.workflow_mode,
  });
  if (audioSummary.length) report.audio = audioSummary;
  writeManifest(projectAbsDir, report);
  return report;
}

/** Resume an interactive project: (re)build + validate + render the montage. */
export async function compileMontage(
  projectId: string,
  opts: { render?: boolean } = {},
): Promise<PipelineReport> {
  const projectAbsDir = resolveProjectDir(projectId);
  const timelineFile = path.join(projectAbsDir, "timeline.json");
  const screenplayFile = path.join(projectAbsDir, "screenplay.json");
  if (!fs.existsSync(timelineFile)) {
    throw new Error(`No timeline.json found for project "${projectId}" at ${projectAbsDir}.`);
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
  const nextSteps: string[] = [];
  const wantRender = opts.render ?? true;
  if (wantRender && !hasErrors && isRemotionAvailable()) {
    const r = await renderTimeline(projectId, projectAbsDir, path.join(projectAbsDir, "timeline.json"), ordered);
    renderedVideoPath = r.outputPath;
    if (!r.rendered) warnings.push(`render: ${r.reason ?? "failed"}${r.log ? ` :: ${r.log}` : ""}`);
  } else if (wantRender && !isRemotionAvailable()) {
    nextSteps.push("Remotion not installed. Run `npm run setup:render` to enable rendering.");
  } else if (hasErrors) {
    nextSteps.push("Timeline has validation errors; resolve them before rendering.");
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
  writeManifest(projectAbsDir, report);
  return report;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function applyMontageOrder(projectDir: string, timeline: Timeline): Timeline {
  const orderFile = path.join(projectDir, "montage-order.json");
  if (!fs.existsSync(orderFile)) return retile(timeline, timeline.items);
  try {
    const order = JSON.parse(fs.readFileSync(orderFile, "utf8")) as string[];
    const bySrc = new Map(timeline.items.map((i) => [i.src, i]));
    const reordered = order.map((src) => bySrc.get(src)).filter((x): x is NonNullable<typeof x> => Boolean(x));
    const leftovers = timeline.items.filter((i) => !order.includes(i.src));
    return retile(timeline, [...reordered, ...leftovers]);
  } catch (err) {
    log.warn(`Could not apply montage-order.json: ${String(err)}`);
    return retile(timeline, timeline.items);
  }
}

/** Recompute startFrames so items tile with no gaps/overlaps after reordering. */
function retile(base: Timeline, items: Timeline["items"]): Timeline {
  let cursor = 0;
  const next = items.map((it, idx) => {
    const startFrame = cursor;
    cursor += it.durationInFrames;
    return { ...it, id: `item-${idx + 1}`, startFrame, transitionInFrames: idx === 0 ? 0 : it.transitionInFrames };
  });
  return { ...base, items: next, durationInFrames: Math.max(1, cursor) };
}

function buildGenPrompt(screenplay: Screenplay, shot: Shot): string {
  const f = shot.openingFrame;
  return `${screenplay.style}. ${shot.action} Framing: ${f.framing}. Lighting: ${f.lighting}. Palette: ${f.palette.join(", ")}.`;
}

function makeProjectId(title: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
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
    lines.push(`## ${scene.index + 1}. ${scene.heading}`, "", `${scene.summary}`, "");
    for (const shot of scene.shots) {
      lines.push(
        `### ${shot.id}`,
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
    lines.push(`${c.shotId}  [${c.source}/${c.provider}]  ${c.attribution}  — ${c.license}`);
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

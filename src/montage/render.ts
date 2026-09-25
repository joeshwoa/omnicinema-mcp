/**
 * Final render: Remotion when installed, ffmpeg assembly otherwise.
 *
 * The server does not import Remotion at compile time — it shells out to the
 * project-local Remotion CLI (never `npx`, which could hit the network). That
 * keeps the MCP server lightweight and makes Remotion optional
 * (`npm run setup:render`). Without it, `assembleWithFfmpeg` produces the same
 * cut (crossfades, Ken Burns, captions, ducked audio) if ffmpeg is on PATH.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.js";
import { run } from "../exec.js";
import { log } from "../logger.js";
import type { Timeline } from "../types.js";
import { assembleWithFfmpeg, isFfmpegAvailable } from "./assemble.js";

function remotionBin(): string {
  return path.join(paths.repoRoot, "node_modules", ".bin", process.platform === "win32" ? "remotion.cmd" : "remotion");
}

export function isRemotionAvailable(): boolean {
  if (process.env.CINEMA_DISABLE_REMOTION === "1") return false;
  return (
    fs.existsSync(path.join(paths.repoRoot, "node_modules", "remotion")) &&
    fs.existsSync(path.join(paths.repoRoot, "node_modules", "@remotion", "cli")) &&
    fs.existsSync(remotionBin())
  );
}

export interface RenderResult {
  rendered: boolean;
  outputPath: string | null;
  /** Which engine produced the file. */
  engine?: "remotion" | "ffmpeg";
  reason?: string;
  log?: string;
}

/** Can this machine produce an MP4 at all? */
export async function renderCapability(): Promise<"remotion" | "ffmpeg" | null> {
  if (isRemotionAvailable()) return "remotion";
  if (await isFfmpegAvailable()) return "ffmpeg";
  return null;
}

export async function renderTimeline(
  projectId: string,
  projectDir: string,
  _timelinePath: string,
  timeline: Timeline,
  opts: { engine?: "auto" | "remotion" | "ffmpeg" } = {},
): Promise<RenderResult> {
  const outputPath = path.join(paths.output, `${projectId}.mp4`);
  fs.mkdirSync(paths.output, { recursive: true });
  const engine = opts.engine ?? "auto";
  const warnings: string[] = [];

  if (engine !== "ffmpeg" && isRemotionAvailable()) {
    // The composition reads props.timeline, so wrap the timeline.
    const propsPath = path.join(projectDir, "render-props.json");
    fs.writeFileSync(propsPath, JSON.stringify({ timeline }), "utf8");
    const entry = path.join(paths.repoRoot, "remotion", "index.ts");
    const args = ["render", entry, "CinemaTimeline", outputPath, `--props=${propsPath}`, `--public-dir=${projectDir}`, "--log=warn"];
    log.info(`Rendering with Remotion: ${remotionBin()} ${args.join(" ")}`);
    const result = await run(remotionBin(), args, paths.repoRoot, 30 * 60_000);
    if (result.code === 0 && fs.existsSync(outputPath)) {
      return { rendered: true, outputPath, engine: "remotion", log: tail(result.stderr) };
    }
    warnings.push(`Remotion render exited with code ${result.code}: ${tail(result.stderr || result.stdout, 8)}`);
    if (engine === "remotion") return { rendered: false, outputPath: null, reason: warnings[0], log: tail(result.stderr || result.stdout) };
    log.warn("Remotion render failed; falling back to ffmpeg assembly.");
  }

  const res = await assembleWithFfmpeg(timeline, projectDir, outputPath);
  if (res.ok) return { rendered: true, outputPath: res.outputPath, engine: "ffmpeg", ...(warnings.length ? { reason: warnings.join(" | ") } : {}) };
  return {
    rendered: false,
    outputPath: null,
    reason: [...warnings, res.reason ?? "ffmpeg assembly failed", isRemotionAvailable() ? "" : "Remotion is not installed (npm run setup:render)."].filter(Boolean).join(" | "),
    log: res.log,
  };
}

function tail(s: string, lines = 20): string {
  return s.split("\n").slice(-lines).join("\n");
}

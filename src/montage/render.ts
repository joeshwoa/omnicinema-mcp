/**
 * Remotion render invocation.
 *
 * The server does not import Remotion at compile time — it shells out to the
 * Remotion CLI. That keeps the MCP server lightweight and lets rendering be an
 * optional extra (`npm run setup:render`). If Remotion isn't installed, rendering
 * is skipped with a clear message and the rest of the pipeline still succeeds.
 */
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.js";
import { run } from "../exec.js";
import { log } from "../logger.js";
import type { Timeline } from "../types.js";

export function isRemotionAvailable(): boolean {
  return (
    fs.existsSync(path.join(paths.repoRoot, "node_modules", "remotion")) &&
    fs.existsSync(path.join(paths.repoRoot, "node_modules", ".bin"))
  );
}

export interface RenderResult {
  rendered: boolean;
  outputPath: string | null;
  reason?: string;
  log?: string;
}

export async function renderTimeline(
  projectId: string,
  projectDir: string,
  timelinePath: string,
  _timeline: Timeline,
): Promise<RenderResult> {
  if (!isRemotionAvailable()) {
    return {
      rendered: false,
      outputPath: null,
      reason: "Remotion is not installed. Run `npm run setup:render` to enable video rendering.",
    };
  }

  const entry = path.join(paths.repoRoot, "remotion", "index.ts");
  const outputPath = path.join(paths.output, `${projectId}.mp4`);
  fs.mkdirSync(paths.output, { recursive: true });

  const args = [
    "remotion",
    "render",
    entry,
    "CinemaTimeline",
    outputPath,
    `--props=${timelinePath}`,
    `--public-dir=${projectDir}`,
    "--log=warn",
  ];

  log.info(`Rendering with Remotion: npx ${args.join(" ")}`);
  const result = await run("npx", args, paths.repoRoot, 20 * 60_000);

  if (result.code === 0 && fs.existsSync(outputPath)) {
    return { rendered: true, outputPath, log: tail(result.stderr) };
  }
  return {
    rendered: false,
    outputPath: null,
    reason: `Remotion render exited with code ${result.code}.`,
    log: tail(result.stderr || result.stdout),
  };
}

function tail(s: string, lines = 20): string {
  return s.split("\n").slice(-lines).join("\n");
}

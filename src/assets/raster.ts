/**
 * SVG → PNG rasterization using whatever local toolchain exists:
 * `rsvg-convert` (librsvg), then `ffmpeg` built with librsvg, then ImageMagick.
 * Returns false (never throws) when no rasterizer is available, so callers can
 * keep the SVG as the deliverable.
 */
import fs from "node:fs";
import path from "node:path";
import { run, which } from "../exec.js";

let cached: Promise<Rasterizer | null> | null = null;

export type Rasterizer = "rsvg-convert" | "ffmpeg" | "magick" | "convert";

async function ffmpegHasSvg(): Promise<boolean> {
  const res = await run("ffmpeg", ["-hide_banner", "-decoders"], process.cwd(), 15_000);
  return res.code === 0 && /\bsvg\b/i.test(res.stdout);
}

export function detectRasterizer(): Promise<Rasterizer | null> {
  if (process.env.CINEMA_DISABLE_RASTER === "1") return Promise.resolve(null);
  cached ??= (async () => {
    if (await which("rsvg-convert")) return "rsvg-convert";
    if ((await which("ffmpeg")) && (await ffmpegHasSvg())) return "ffmpeg";
    if (await which("magick")) return "magick";
    if (await which("convert")) return "convert";
    return null;
  })();
  return cached;
}

/** Reset the detection cache (tests toggle CINEMA_DISABLE_RASTER). */
export function resetRasterizerCache(): void {
  cached = null;
}

export async function rasterizeSvg(svgPath: string, pngPath: string, width: number, height: number, background?: string): Promise<boolean> {
  const tool = await detectRasterizer();
  if (!tool) return false;
  fs.mkdirSync(path.dirname(pngPath), { recursive: true });
  const w = String(Math.round(width));
  const h = String(Math.round(height));
  let res;
  switch (tool) {
    case "rsvg-convert":
      res = await run("rsvg-convert", ["-w", w, "-h", h, ...(background ? ["-b", background] : []), "-o", pngPath, svgPath], process.cwd(), 60_000);
      break;
    case "ffmpeg":
      res = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-width", w, "-height", h, "-i", svgPath, "-frames:v", "1", pngPath], process.cwd(), 60_000);
      break;
    default:
      res = await run(tool, ["-background", background ?? "none", "-density", "96", svgPath, "-resize", `${w}x${h}!`, pngPath], process.cwd(), 60_000);
  }
  return res.code === 0 && fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0;
}

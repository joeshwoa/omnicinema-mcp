/**
 * ffmpeg assembly fallback — renders a timeline to MP4 without Remotion.
 *
 * Same editorial result as the Remotion composition, built as one ffmpeg
 * filtergraph: stills get Ken Burns motion (zoompan), videos are trimmed /
 * cropped / frame-rate matched (and held on their last frame if short), scene
 * boundaries crossfade (xfade), the title card and captions are drawn with
 * drawtext, the soundtrack is faded and side-chain ducked under the voiceover,
 * and the film fades to black at the end. Output length == timeline length.
 */
import fs from "node:fs";
import path from "node:path";
import { run, which } from "../exec.js";
import { log } from "../logger.js";
import type { Timeline, TimelineItem } from "../types.js";

export interface AssembleResult {
  ok: boolean;
  outputPath: string | null;
  reason?: string;
  log?: string;
}

export async function isFfmpegAvailable(): Promise<boolean> {
  return Boolean(await which("ffmpeg"));
}

function zoomExpr(motion: TimelineItem["motion"], N: number): { z: string; x: string; y: string } {
  const p = `(on/${Math.max(1, N - 1)})`;
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  switch (motion) {
    case "push-in": return { z: `1.01+0.07*${p}`, x: cx, y: cy };
    case "pull-out": return { z: `1.08-0.07*${p}`, x: cx, y: cy };
    case "pan-left": return { z: "1.07", x: `(iw-iw/zoom)*(1-${p})`, y: cy };
    case "pan-right": return { z: "1.07", x: `(iw-iw/zoom)*${p}`, y: cy };
    case "rise": return { z: "1.07", x: cx, y: `(ih-ih/zoom)*(1-${p})` };
    case "handheld": return { z: "1.05", x: `${cx}+sin(on/9)*iw*0.004`, y: `${cy}+cos(on/13)*ih*0.004` };
    default: return { z: `1.02+0.03*${p}`, x: cx, y: cy };
  }
}

function esc(s: string): string {
  // For filter option values inside single quotes.
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
}

export async function assembleWithFfmpeg(timeline: Timeline, projectDir: string, outputPath: string, timeoutMs = 20 * 60_000): Promise<AssembleResult> {
  if (!(await isFfmpegAvailable())) return { ok: false, outputPath: null, reason: "ffmpeg not found on PATH." };
  const { fps, width: W, height: H } = timeline;
  const inputs: string[] = [];
  const filters: string[] = [];
  const tmp = path.join(projectDir, ".assemble");
  fs.mkdirSync(tmp, { recursive: true });
  let idx = 0;

  // ── video segments ──
  const segs: string[] = [];
  timeline.items.forEach((it, i) => {
    const N = it.durationInFrames;
    const next = timeline.items[i + 1];
    const hold = next ? Math.min(next.transitionInFrames, next.durationInFrames) : 0;
    const frames = N + hold;
    const abs = path.join(projectDir, it.src);
    const label = `v${i}`;
    if (it.kind === "video") {
      inputs.push("-i", abs);
      filters.push(`[${idx}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},setsar=1,tpad=stop_mode=clone:stop_duration=${(frames / fps).toFixed(3)},trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p,settb=1/${fps}[${label}]`);
    } else {
      inputs.push("-i", abs);
      const { z, x, y } = zoomExpr(it.motion, frames);
      // Upscale first so zoompan motion is smooth (it works on integer pixels).
      filters.push(`[${idx}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,crop=${W * 2}:${H * 2},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${W}x${H}:fps=${fps},setsar=1,trim=end_frame=${frames},setpts=PTS-STARTPTS,format=yuv420p,settb=1/${fps}[${label}]`);
    }
    idx++;
    segs.push(label);
  });

  // Chain: hard cuts via concat, scene changes via xfade over the held frames.
  let acc = segs[0]!;
  let accFrames = timeline.items[0]!.durationInFrames;
  for (let i = 1; i < segs.length; i++) {
    const it = timeline.items[i]!;
    const prevHold = Math.min(it.transitionInFrames, it.durationInFrames);
    const out = `c${i}`;
    if (prevHold > 0) {
      // acc currently includes the previous item's hold frames at its end.
      filters.push(`[${acc}][${segs[i]}]xfade=transition=fade:duration=${(prevHold / fps).toFixed(4)}:offset=${(accFrames / fps).toFixed(4)},settb=1/${fps}[${out}]`);
    } else {
      filters.push(`[${acc}][${segs[i]}]concat=n=2:v=1:a=0,settb=1/${fps}[${out}]`);
    }
    acc = out;
    accFrames += it.durationInFrames;
  }
  // Trim any trailing hold and add overlays.
  let v = acc;
  const total = timeline.durationInFrames;
  const overlays: string[] = [`trim=end_frame=${total}`, "setpts=PTS-STARTPTS"];
  const fontsize = Math.round(H * 0.041);
  if (timeline.titleCard) {
    const tf = path.join(tmp, "title.txt");
    fs.writeFileSync(tf, timeline.titleCard.title, "utf8");
    const d = timeline.titleCard.durationInFrames / fps;
    const alpha = `if(lt(t,0.4),t/0.4,if(gt(t,${(d - 0.6).toFixed(2)}),max(0,(${d.toFixed(2)}-t)/0.6),1))`;
    overlays.push(`drawtext=font='Poppins\\:style=Bold':textfile='${esc(tf)}':fontsize=${Math.round(H * 0.089)}:fontcolor=white:shadowcolor=black@0.6:shadowx=0:shadowy=4:x=(w-text_w)/2:y=(h-text_h)/2:alpha='${alpha}':enable='lte(t,${d.toFixed(2)})'`);
  }
  (timeline.captions ?? []).forEach((c, i) => {
    const cf = path.join(tmp, `cap-${i}.txt`);
    fs.writeFileSync(cf, c.text, "utf8");
    const a = c.startFrame / fps;
    const b = (c.startFrame + c.durationInFrames) / fps;
    overlays.push(`drawtext=font='Poppins\\:style=SemiBold':textfile='${esc(cf)}':fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${Math.round(fontsize * 0.4)}:x=(w-text_w)/2:y=h-text_h-${Math.round(H * 0.075)}:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
  });
  const fo = timeline.fadeOutFrames ?? 0;
  if (fo > 0) overlays.push(`fade=t=out:st=${((total - fo) / fps).toFixed(3)}:d=${(fo / fps).toFixed(3)}`);
  filters.push(`[${v}]${overlays.join(",")}[vout]`);
  v = "vout";

  // ── audio ──
  const tracks = (timeline.audioTracks ?? []).filter((t) => fs.existsSync(path.join(projectDir, t.src)));
  let aout: string | null = null;
  if (tracks.length) {
    const voLabels: string[] = [];
    const bedLabels: string[] = [];
    tracks.forEach((t, i) => {
      inputs.push("-i", path.join(projectDir, t.src));
      const start = t.startFrame / fps;
      const dur = t.durationInFrames / fps;
      const parts = [`atrim=0:${dur.toFixed(3)}`, "asetpts=PTS-STARTPTS", "aresample=48000", "aformat=channel_layouts=stereo"];
      if (t.fadeInFrames) parts.push(`afade=t=in:st=0:d=${(t.fadeInFrames / fps).toFixed(3)}`);
      if (t.fadeOutFrames) parts.push(`afade=t=out:st=${Math.max(0, dur - t.fadeOutFrames / fps).toFixed(3)}:d=${(t.fadeOutFrames / fps).toFixed(3)}`);
      parts.push(`volume=${t.volume.toFixed(3)}`);
      if (start > 0) parts.push(`adelay=${Math.round(start * 1000)}:all=1`);
      const lab = `a${i}`;
      filters.push(`[${idx}:a]${parts.join(",")}[${lab}]`);
      idx++;
      (t.role === "voiceover" ? voLabels : bedLabels).push(lab);
    });
    const mixIn: string[] = [];
    if (voLabels.length) {
      const vo = voLabels.length > 1 ? (filters.push(`[${voLabels.join("][")}]amix=inputs=${voLabels.length}:normalize=0[vomix]`), "vomix") : voLabels[0]!;
      const ducked = tracks.some((t) => t.duckUnderVoiceover);
      if (bedLabels.length && ducked) {
        filters.push(`[${vo}]asplit=2[vo1][vosc]`);
        const bed = bedLabels.length > 1 ? (filters.push(`[${bedLabels.join("][")}]amix=inputs=${bedLabels.length}:normalize=0[bedmix]`), "bedmix") : bedLabels[0]!;
        filters.push(`[${bed}][vosc]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=450:makeup=1[bedduck]`);
        mixIn.push("vo1", "bedduck");
      } else {
        mixIn.push(vo, ...bedLabels);
      }
    } else mixIn.push(...bedLabels);
    filters.push(`[${mixIn.join("][")}]amix=inputs=${mixIn.length}:normalize=0:duration=longest,alimiter=limit=0.89,apad[aout]`);
    aout = "aout";
  }

  const graphFile = path.join(tmp, "graph.txt");
  fs.writeFileSync(graphFile, filters.join(";\n"), "utf8");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const args = [
    "-hide_banner", "-loglevel", "error", "-y", ...inputs,
    "-filter_complex_script", graphFile,
    "-map", `[${v}]`, ...(aout ? ["-map", `[${aout}]`, "-c:a", "aac", "-b:a", "192k"] : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    "-r", String(fps), "-frames:v", String(total), ...(aout ? ["-t", (total / fps).toFixed(3)] : []),
    outputPath,
  ];
  log.info(`Assembling with ffmpeg (${timeline.items.length} items, ${tracks.length} audio) -> ${outputPath}`);
  const res = await run("ffmpeg", args, projectDir, timeoutMs);
  if (res.code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return { ok: true, outputPath };
  }
  return { ok: false, outputPath: null, reason: `ffmpeg exited with code ${res.code}`, log: (res.stderr || res.stdout).split("\n").slice(-15).join("\n") };
}
